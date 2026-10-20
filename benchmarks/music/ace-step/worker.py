"""Compare ACE-Step checkpoints using the installed inference runtime, without a server."""

import argparse
import dataclasses
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cases", nargs="*")
    parser.add_argument("--request-sequence", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    events = args.output / "events.jsonl"

    def emit(kind, **data):
        record = {"kind": kind, "monotonic": time.monotonic(), **data}
        with events.open("a") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        print(json.dumps(record, ensure_ascii=False), flush=True)

    started = time.monotonic()
    emit("import_start", pid=os.getpid(), model=args.model)
    sys.path.insert(0, args.runtime)
    import torch
    from acestep.handler import AceStepHandler
    from acestep.llm_inference import LLMHandler
    from acestep.inference import GenerationParams, GenerationConfig, generate_music

    versions = {n: importlib.metadata.version(n) for n in
                ("torch", "transformers", "diffusers", "soundfile")}
    emit("import_done", seconds=time.monotonic() - started, versions=versions,
         hip=torch.version.hip, gpu=torch.cuda.get_device_name(0))
    handler = AceStepHandler()
    llm = LLMHandler()  # Uninitialized: same auxiliary-LM policy as production.
    torch.cuda.reset_peak_memory_stats()
    loading = time.monotonic()
    emit("load_start")
    status, ok = handler.initialize_service(
        project_root=args.runtime, config_path=args.model, device="cuda",
        use_flash_attention=True, compile_model=False,
        offload_to_cpu=False, offload_dit_to_cpu=False,
    )
    torch.cuda.synchronize()
    if not ok:
        emit("load_failed", status=status)
        raise RuntimeError(status)
    emit("load_done", seconds=time.monotonic() - loading, status=status,
         dtype=str(handler.dtype), attention=handler.config._attn_implementation,
         parameters=sum(p.numel() for p in handler.model.parameters()),
         allocated=torch.cuda.memory_allocated(), reserved=torch.cuda.memory_reserved(),
         peak_allocated=torch.cuda.max_memory_allocated(),
         peak_reserved=torch.cuda.max_memory_reserved())

    cases = [
        ("ambient30-first", 30, 12345, 120, "unknown", "[Instrumental]",
         "Cinematic electronic ambient music, slow evolving synthesizers, deep bass, "
         "subtle percussion, no vocals, 120 BPM."),
        ("ambient30-repeat", 30, 12345, 120, "unknown", "[Instrumental]",
         "Cinematic electronic ambient music, slow evolving synthesizers, deep bass, "
         "subtle percussion, no vocals, 120 BPM."),
        ("jazz60", 60, 23456, 100, "unknown", "[Instrumental]",
         "Acoustic jazz trio, expressive grand piano melody, warm upright double bass, "
         "crisp brushed drums, intimate studio recording, natural dynamics, "
         "clear instrument separation, cheerful relaxed mood, no vocals, 100 BPM."),
        ("vocal45", 45, 34567, 110, "ja",
         "[Verse]\n朝の光が 窓をひらく\n小さな風が 頬をなでる\n"
         "昨日の雨も 虹に変わる\n君と歩こう 新しい道\n"
         "[Chorus]\n空へ 空へ 歌を届けよう\n遠い明日も きっと輝く\n"
         "一歩 一歩 心を重ねて\nこの街から 夢を奏でよう",
         "Japanese acoustic pop song, clear female lead vocal singing Japanese lyrics, "
         "bright acoustic guitar, warm piano, melodic electric bass, light drums, "
         "uplifting chorus, clean balanced studio production, 110 BPM."),
    ]
    if args.request_sequence:
        requests = json.loads(args.request_sequence.read_text())
        cases = [(item["id"], item["options"]["duration_seconds"],
                  item["options"]["seed"], item["options"].get("bpm"),
                  "unknown", "[Instrumental]", item["text"]) for item in requests]
    if args.cases and not args.request_sequence:
        effects = json.loads(Path(__file__).with_name("stable-sfx.json").read_text())
        cases.extend((item["id"], item["options"]["duration_seconds"],
                      item["options"]["seed"], None, "unknown", "[Instrumental]", item["text"])
                     for item in effects if item["id"] in args.cases)
    for name, duration, seed, bpm, language, lyrics, caption in cases:
        if args.cases and name not in args.cases:
            continue
        params = GenerationParams(
            caption=caption, lyrics=lyrics, duration=duration, seed=seed, bpm=bpm,
            vocal_language=language, inference_steps=8, thinking=False,
            instrumental=lyrics == "[Instrumental]", shift=3.0,
        )
        config = GenerationConfig(batch_size=1, use_random_seed=False,
                                  seeds=[seed], audio_format="wav32")
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        emit("generation_start", case=name, params=dataclasses.asdict(params),
             config=dataclasses.asdict(config), allocated=torch.cuda.memory_allocated(),
             reserved=torch.cuda.memory_reserved())
        start = time.monotonic()
        result = generate_music(handler, llm, params=params, config=config,
                                save_dir=str(args.output / name))
        torch.cuda.synchronize()
        seconds = time.monotonic() - start
        files = [a.get("path") for a in result.audios]
        emit("generation_done", case=name, success=result.success,
             status=result.status_message, seconds=seconds, rtf=seconds / duration,
             realtime_speed=duration / seconds, files=files,
             time_costs=result.extra_outputs.get("time_costs", {}),
             allocated=torch.cuda.memory_allocated(), reserved=torch.cuda.memory_reserved(),
             peak_allocated=torch.cuda.max_memory_allocated(),
             peak_reserved=torch.cuda.max_memory_reserved(),
             sha256={p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in files if p})
        if not result.success:
            raise RuntimeError(result.status_message)
        del result
    emit("finished", seconds=time.monotonic() - started)


if __name__ == "__main__":
    main()
