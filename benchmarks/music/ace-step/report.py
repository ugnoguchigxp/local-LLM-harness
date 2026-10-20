"""Summarize local ACE-Step/audio.cpp trials and build a portable listening report."""

import argparse
import base64
import html
import json
import re
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf


def json_lines(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def trial_directory(root, name):
    games = root / f"{name}-games"
    if games.exists():
        return games
    final = root / f"{name}-final"
    return final if final.exists() else root / name


def audio_metrics(path):
    audio, rate = sf.read(path, always_2d=True)
    finite = np.isfinite(audio)
    if not finite.all():
        raise ValueError(f"{path}: {int((~finite).sum())} nonfinite samples")
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(audio**2)))
    width = rate // 20
    frames = audio[:len(audio)//width*width].reshape(-1, width, audio.shape[1])
    quiet = float(np.mean(np.sqrt(np.mean(frames**2, axis=(1, 2))) < 0.001))
    loudness = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", str(path),
                               "-af", "ebur128=peak=true", "-f", "null", "-"],
                              capture_output=True, text=True, check=True).stderr
    summary = loudness.rsplit("Summary:", 1)[-1]
    integrated = re.search(r"I:\s+(-?[\d.]+) LUFS", summary)
    true_peak = re.search(r"Peak:\s+(-?[\d.]+) dBFS", summary)
    return {"duration": len(audio)/rate, "sample_rate": rate, "channels": audio.shape[1],
            "peak_dbfs": float(20*np.log10(max(peak, 1e-15))),
            "rms_dbfs": float(20*np.log10(max(rms, 1e-15))),
            "full_scale_samples": int((np.abs(audio) >= 1).sum()), "nonfinite": 0,
            "full_scale_fraction": float(np.mean(np.abs(audio) >= 1)),
            "integrated_lufs": float(integrated[1]) if integrated else None,
            "true_peak_dbfs": float(true_peak[1]) if true_peak else None,
            "quiet_fraction_below_minus60_dbfs": quiet,
            "file_bytes": path.stat().st_size}


def plot_memory(root, names):
    """Plot process counters separately; unified-memory counters must not be added."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    names = [name for name in names if (trial_directory(root, name) / "memory.jsonl").exists()]
    columns = min(3, max(1, len(names)))
    rows = max(1, (len(names)+columns-1)//columns)
    fig, axes = plt.subplots(rows, columns, figsize=(5.3*columns, 4*rows),
                             squeeze=False, constrained_layout=True)
    for ax, name in zip(axes.flat, names):
        directory = trial_directory(root, name)
        samples = json_lines(directory / "memory.jsonl")
        if not samples:
            ax.set_visible(False)
            continue
        start = samples[0]["monotonic"]
        t = [s["monotonic"]-start for s in samples]
        for key, label, color in (("kfd_process_bytes", "Process ROCm allocation (sampled)", "#315cb5"),
                                  ("rss", "Process RSS", "#b35a22")):
            ax.plot(t, [(s.get(key) or 0)/1024**3 for s in samples], label=label, color=color)
        for event in json_lines(directory / "events.jsonl"):
            if event["kind"] == "generation_start":
                ax.axvline(event["monotonic"]-start, color="#9098a2", alpha=0.4)
        ax.set(title=name, xlabel="Elapsed seconds", ylabel="GiB")
        ax.grid(alpha=0.2)
        ax.legend(fontsize=8)
    for ax in list(axes.flat)[len(names):]:
        ax.set_visible(False)
    fig.suptitle("Radeon 8060S: music / sound-effect trial memory (0.5 s sampling)")
    fig.savefig(root / "memory.png", dpi=170)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--title", default="音楽・効果音 比較試聴 — 2026-10-20")
    args = parser.parse_args()
    root = args.root
    listen = root / "listen"
    listen.mkdir(exist_ok=True)
    results = []
    sessions = {}
    names = ("turbo", "xl", "stable-music", "stable-sfx", "stable-sfx-cpu", "ace-sfx")
    for name in names:
        directory = trial_directory(root, name)
        if not directory.exists():
            continue
        memory = json_lines(directory / "memory.jsonl")
        sessions[name] = {key: max((r.get(key) or 0 for r in memory), default=0)
                          for key in ("rss", "hwm", "pss", "kfd_process_bytes", "process_swap")}
        sessions[name]["minimum_system_available"] = min(
            (r["system_available"] for r in memory), default=0)
        events = json_lines(directory / "events.jsonl")
        if events:
            load = next((e for e in events if e["kind"] == "load_done"), None)
            sessions[name]["load"] = load
            for event in events:
                if event["kind"] != "generation_done" or not event["success"]:
                    continue
                start = next(e for e in events if e["kind"] == "generation_start"
                             and e["case"] == event["case"])
                samples = [r for r in memory if start["monotonic"] <= r["monotonic"] <= event["monotonic"]]
                results.append({"model": name, "case": event["case"],
                                "seconds": event["seconds"], "path": event["files"][0],
                                "prompt": start["params"]["caption"],
                                "lyrics": start["params"]["lyrics"],
                                "seed": start["params"]["seed"],
                                "requested_duration": start["params"]["duration"],
                                "torch_peak_allocated": event["peak_allocated"],
                                "torch_peak_reserved": event["peak_reserved"],
                                "sampled_kfd_peak": max((r["kfd_process_bytes"] for r in samples), default=0),
                                "time_costs": event["time_costs"]})
        else:
            log = (directory / "process.log").read_text()
            command = json.loads((directory / "command.json").read_text())["command"]
            requests = {}
            if "--request-sequence" in command:
                sequence = Path(command[command.index("--request-sequence")+1])
                requests = {r["id"]: r for r in json.loads(sequence.read_text())}
            timings = re.findall(r"\[TIMING\] request\.([\w-]+)\.wall_ms ([\d.]+)", log)
            prepare = re.search(r"\[TIMING\] session.prepare_ms ([\d.]+)", log)
            if prepare:
                sessions[name]["prepare_seconds"] = float(prepare[1])/1000
            for case, milliseconds in timings:
                files = list((directory / "audio" / case).glob("*.wav"))
                if not files:
                    files = list((directory / "audio").glob(f"{case}.wav"))
                for path in files:
                    results.append({"model": name, "case": case,
                                    "seconds": float(milliseconds)/1000, "path": str(path),
                                    "prompt": requests.get(case, {}).get("text", ""),
                                    "seed": requests.get(case, {}).get("options", {}).get("seed"),
                                    "requested_duration": requests.get(case, {}).get("options", {}).get("duration_seconds")})
    for row in results:
        source = Path(row["path"])
        row["audio"] = audio_metrics(source)
        row["rtf"] = row["seconds"]/row["audio"]["duration"]
        row["realtime_speed"] = 1/row["rtf"]
        target = listen / f"{row['model']}-{row['case']}.mp3"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source),
                        "-c:a", "libmp3lame", "-q:a", "2", str(target)], check=True)
        row["listen_path"] = str(target)
    music_names = ("turbo", "xl", "stable-music")
    levels = [r["audio"]["integrated_lufs"] for r in results
              if r["model"] in music_names and r["audio"]["integrated_lufs"] is not None]
    comparison_level = min([-23.0, *levels])
    for row in results:
        level = row["audio"]["integrated_lufs"]
        if row["model"] not in music_names or level is None:
            continue
        row["comparison_gain_db"] = comparison_level-level
        row["comparison_target_lufs"] = comparison_level
        directory = root / "listen-matched"
        directory.mkdir(exist_ok=True)
        target = directory / f"{row['model']}-{row['case']}.mp3"
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", row["path"],
                        "-af", f"volume={row['comparison_gain_db']}dB", "-c:a", "libmp3lame",
                        "-q:a", "2", str(target)], check=True)
        row["matched_listen_path"] = str(target)
    for name, session in sessions.items():
        command = trial_directory(root, name) / "command.json"
        paths = [Path(r["path"]) for r in results if r["model"] == name]
        if command.exists() and paths:
            baseline = json.loads(command.read_text())["baseline"]["unix"]
            session["first_wav_ready_seconds"] = min(p.stat().st_mtime for p in paths) - baseline
    (root / "summary.json").write_text(json.dumps({"sessions": sessions, "results": results}, indent=2))
    plot_memory(root, names)
    blocks = []
    titles = {"ambient30-first": "電子音のBGM・30秒（初回）",
              "ambient30-repeat": "電子音のBGM・30秒（2回目）",
              "jazz60": "アコースティック・ジャズ・60秒", "vocal45": "日本語ボーカル・45秒",
              "gravel8-first": "砂利の足音・8秒（初回）", "gravel8-repeat": "砂利の足音・8秒（2回目）",
              "door5": "木製ドア・5秒", "rain10": "雨と遠雷・10秒", "scifi4": "SF武器の充電と発射・4秒",
              "ui-confirm1p5": "UI決定音・1.5秒", "ui-denied1p5": "UI拒否音・1.5秒",
              "magic4": "魔法の発動・4秒", "laser3": "レーザー・3秒", "explosion5": "爆発・5秒",
              "orchestra30": "クラシック・オーケストラ・30秒"}
    labels = {"turbo": "ACE-Step 1.5 Turbo / PyTorch F32",
              "xl": "ACE-Step 1.5 XL Turbo / PyTorch F32",
              "stable-music": "Stable Audio 3 Small Music / Q8・AMD GPU",
              "stable-sfx": "Stable Audio 3 Small SFX / Q8・AMD GPU",
              "stable-sfx-cpu": "Stable Audio 3 Small SFX / Q8・CPU 8 threads",
              "ace-sfx": "ACE-Step 1.5 Turbo / 効果音プロンプト・実験"}
    session_table = ("<h2>起動とメモリ</h2><table><thead><tr><th>構成</th><th>最初のWAVまで</th>"
                     "<th>GPU割当・観測最大</th><th>RSS最大（VmHWM）</th></tr></thead><tbody>")
    for name, session in sessions.items():
        ready = session.get("first_wav_ready_seconds", 0)
        session_table += (f"<tr><td>{html.escape(labels[name])}</td><td>{ready:.2f}秒</td>"
                          f"<td>{session['kfd_process_bytes']/1024**3:.2f} GiB</td>"
                          f"<td>{session['hwm']/1024**3:.2f} GiB</td></tr>")
    session_table += ("</tbody></table><p>GPUとRSSは統合メモリ上で重複するため加算しません。"
                      "GPU値は0.5秒間隔の観測値です。起動時間は既存のOS・kernel cacheがある環境での参考値です。</p>")
    for case in dict.fromkeys(r["case"] for r in results):
        blocks.append(f"<h2>{html.escape(titles.get(case, case))}</h2><div class='grid'>")
        for row in (r for r in results if r["case"] == case):
            a = row["audio"]
            target = Path(row["listen_path"]).relative_to(root)
            encoded_audio = base64.b64encode((root / target).read_bytes()).decode("ascii")
            gain = 1.0
            if row["model"] in ("turbo", "xl", "stable-music") and a["integrated_lufs"] is not None:
                gain = 10**((comparison_level-a["integrated_lufs"])/20)
            wav = Path(row["path"]).relative_to(root)
            level_note = (f"<p style='color:#9b300d'>音量上限に到達：{a['full_scale_fraction']:.3%}のサンプル</p>"
                          if a["full_scale_samples"] else "")
            requested = row.get("requested_duration")
            if requested is not None and abs(requested-a["duration"]) > 0.02:
                level_note += (f"<p style='color:#9b300d'>指定 {requested}秒 → 実出力 {a['duration']:.2f}秒</p>")
            blocks.append(f"<section><h3>{html.escape(labels[row['model']])}</h3>"
                          f"<p>{a['duration']:.0f}秒の音声 / 生成 {row['seconds']:.2f}秒 / "
                          f"{row['realtime_speed']:.2f}倍速</p>"
                          f"<audio controls preload='none' data-comparison-gain='{gain}' src='data:audio/mpeg;base64,{encoded_audio}'></audio>"
                          f"<p>RMS {a['rms_dbfs']:.1f} dBFS / peak {a['peak_dbfs']:.1f} dBFS / "
                          f"{a['integrated_lufs']} LUFS</p>"
                          + level_note +
                          f"<a href='{wav}'>元WAV</a><details><summary>生成条件</summary>"
                          f"<p>seed: {row.get('seed')}</p><p>{html.escape(row.get('prompt', ''))}</p>"
                          f"<pre style='white-space:pre-wrap'>{html.escape(row.get('lyrics', ''))}</pre>"
                          f"</details></section>")
        blocks.append("</div>")
    document = """<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>音楽・効果音 比較試聴</title>
<style>body{font:16px/1.6 system-ui;max-width:1200px;margin:40px auto;padding:0 20px;background:#f7f8fa;color:#1b2430}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}section{background:white;padding:20px;border:1px solid #d9dfe5;border-radius:12px}audio{width:100%}h2{margin-top:40px}a{color:#285bb4}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #ccd3dc}</style>
<h1>REPORT_TITLE</h1>
<p>ACE-Step通常版・XLとStable Audio 3 Small Q8の実機試験。8 steps、batch 1。
試聴用MP3は元WAVから追加の音量調整なしで変換。元WAVも取得できます。
同じseedでも異なるモデルの曲は同一になりません。音質は聴き比べて判断してください。</p>
<p>生成時間はロード済みモデルの処理時間です。常駐サービスがあるPCでの参考測定で、APIの待ち時間は含みません。
測定値の詳細は<a href="summary.json">JSON</a>を参照してください。</p>
<p>ACE-StepのF32とStable AudioのQ8は、モデル・実行環境・精度を含む実用比較です。
一部の出力には0 dBFSに達した箇所があり、該当カードに表示しています。音量上限の影響も含めて試聴してください。</p>
<label><input type="checkbox" id="match-level" checked>楽曲の音量差をそろえる（MATCH_LEVEL_TARGET LUFSへ減衰、効果音と元ファイルは変更しません）</label>
""" + session_table + "\n".join(blocks)
    encoded_plot = base64.b64encode((root / "memory.png").read_bytes()).decode("ascii")
    document += (f'<h2>メモリ推移</h2><p>unified memoryのため、青線と橙線は加算しません。</p>'
                 f'<img src="data:image/png;base64,{encoded_plot}" style="max-width:100%" alt="各試験プロセスのメモリ推移">'
                 '<details><summary>計測データ</summary><pre>'
                 + html.escape(json.dumps({"sessions": sessions, "results": results}, ensure_ascii=False, indent=2))
                 + '</pre></details><script>function setLevel(){for(const a of document.querySelectorAll("audio")){a.volume=document.getElementById("match-level").checked?Number(a.dataset.comparisonGain):1}}document.getElementById("match-level").addEventListener("change",setLevel);setLevel();</script></html>')
    document = document.replace("REPORT_TITLE", html.escape(args.title))
    document = document.replace("MATCH_LEVEL_TARGET", f"{comparison_level:.1f}")
    (root / "listening.html").write_text(document)
    for row in results:
        print(row["model"], row["case"], f"{row['seconds']:.2f}s",
              f"{row['realtime_speed']:.2f}x", row["audio"])
    print("Session memory:", json.dumps(sessions, ensure_ascii=False))


if __name__ == "__main__":
    main()
