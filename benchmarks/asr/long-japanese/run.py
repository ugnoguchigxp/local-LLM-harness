#!/usr/bin/env python3
"""Compare current Granite, candidate LFM, and reference Whisper without switching LARM."""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import random
import socket
import subprocess
import time
import urllib.error
import urllib.request

from prepare import outside_repo

ENGINE = Path('/srv/ai/apps/audio.cpp-lfm25-jp-20261025')
WEIGHTS = '/srv/ai/models/LFM2.5-Audio-1.5B-JP-GGUF'


def fetch(url, body=None, content_type='application/json', timeout=180):
    req = urllib.request.Request(url, data=body, headers={'Content-Type':content_type})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def host():
    return {'loadavg':os.getloadavg(), 'meminfo':[l for l in Path('/proc/meminfo').read_text().splitlines()
            if l.startswith(('MemAvailable:','SwapFree:'))]}


def transcribe(provider, path):
    boundary = 'larm-asr-long-20261025'
    port, model = {'granite':(8089,'granite-speech-4.1-2b'),
                   'lfm':(18096,'lfm25-jp-asr'),
                   'lfm_whole':(18096,'lfm25-jp-asr-whole'),
                   'lfm_vad':(18096,'lfm25-jp-asr'),
                   'whisper':(8085,'whisper-large-v3-turbo')}[provider]
    fields = {'model':model, 'response_format':'json'}
    # Granite's actual dialogue API uses automatic language selection.
    if provider != 'granite':
        fields['language'] = 'ja'
    parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
             for k,v in fields.items()]
    parts += [f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="input.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode(),
              Path(path).read_bytes(), f'\r\n--{boundary}--\r\n'.encode()]
    started = time.perf_counter()
    try:
        if provider=='lfm_vad':
            body={'model':model,'request':{'audio_base64':base64.b64encode(Path(path).read_bytes()).decode(),
                  'options':{'max_tokens':128,'audio_chunk_mode':'vad'}}}
            response=fetch(f'http://127.0.0.1:{port}/v1/tasks/run',json.dumps(body).encode())
            # An empty VAD result may omit text entirely.
            response.setdefault('text','')
        else:
            response = fetch(f'http://127.0.0.1:{port}/v1/audio/transcriptions', b''.join(parts),
                             f'multipart/form-data; boundary={boundary}')
        assert isinstance(response.get('text'),str),response
        return {'text':response['text'],'seconds':time.perf_counter()-started,'error':None,'response':response}
    except Exception as exc:
        detail = exc.read().decode(errors='replace') if isinstance(exc,urllib.error.HTTPError) else ''
        return {'text':'','seconds':time.perf_counter()-started,'error':f'{type(exc).__name__}: {exc} {detail}'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--phase',choices=['main','diagnostics','stress-matched','all'],default='all')
    parser.add_argument('--repeats',type=int,default=3)
    args = parser.parse_args()
    output = outside_repo(args.output)
    output.mkdir(parents=True,exist_ok=False)
    corpus = json.loads((args.corpus/'manifest.json').read_text())
    clean = [c for c in corpus['clips'] if c['condition']=='clean']
    stress = [c for c in corpus['clips'] if c['condition'] in ('noise15db','speed1.2')]
    controls = [c for c in corpus['clips'] if c['condition']=='control']
    config = {'host':'127.0.0.1','port':18096,'backend':'cpu','threads':8,'lazy_load':True,
              'max_loaded_models':2,'models':[]}
    for label,mode in [('lfm25-jp-asr','auto'),('lfm25-jp-asr-whole','none')]:
        config['models'].append({'id':label,'family':'lfm2_audio','task':'asr','mode':'offline','path':WEIGHTS,
            'session_options':{'lfm2_audio.model_gguf':'LFM2.5-Audio-1.5B-JP-Q8_0.gguf',
                               'lfm2_audio.vad_model_path':str(ENGINE/'assets/framework/models/silero_vad')},
            'default_request_options':{'max_tokens':'1024','audio_chunk_mode':mode,'audio_chunk_duration_sec':'30'}})
    (output/'server.json').write_text(json.dumps(config,indent=2)+'\n')
    # Refuse an occupied port; never stop somebody else's trial.
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        probe.bind(('127.0.0.1',18096))
    log = (output/'server.log').open('w')
    proc = subprocess.Popen([str(ENGINE/'build-cpu/bin/audiocpp_server'),'--config',str(output/'server.json'),'--log'],
                            cwd=ENGINE,stdout=log,stderr=subprocess.STDOUT)
    metadata = {'phase':args.phase,'repeats':args.repeats,'started_at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
                'source_revision':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
                'lfm_engine_revision':subprocess.check_output(['git','-C',str(ENGINE),'rev-parse','HEAD'],text=True).strip(),
                'lfm_model_revision':'64b96718b341dbd5650f9e85627cecdcbd4ac61b','lfm_pid':proc.pid,
                'before':host(),'status':'running',
                'scope':'Warm direct backend API, not LARM lease/admission; original providers retained',
                'primary':'granite_segmented and lfm_auto_full; identical_segments is additional controlled comparison',
                'runtime_identity':'ornith1.5Strix / saaa-conversation-gemma4-26b-voice -> stt-granite -> granite-asr -> granite-asr.service / 8089',
                'segmentation':'Known TTS sentence boundaries, <12s; ideal boundary test, not live VAD'}
    rows_file = (output/'runs.jsonl').open('w')

    def measure(clip,method,repeat):
        provider,segmented = {'granite_segmented':('granite',True),'lfm_auto_full':('lfm',False),
                              'lfm_identical_segments':('lfm',True),'lfm_no_chunk_full':('lfm_whole',False),
                              'lfm_vad_control':('lfm_vad',False),
                              'whisper_full_reference':('whisper',False)}[method]
        files = clip['segments'] if segmented else [clip['audio']]
        before = host()
        parts = [transcribe(provider,path) for path in files]
        row = {'clip_id':clip['id'],'text_id':clip['text_id'],'voice':clip['voice'],'category':clip['category'],
               'condition':clip['condition'],'method':method,'repeat':repeat,'reference':clip['reference'],
               'probes':clip['probes'],'audio_seconds':clip['audio_seconds'],
               'seconds':sum(p['seconds'] for p in parts),'last_segment_seconds':parts[-1]['seconds'],
               'segment_seconds':[p['seconds'] for p in parts],'segments':parts,
               'text':''.join(p['text'] for p in parts),'errors':[p['error'] for p in parts if p['error']],
               'host_before':before,'host_after':host()}
        row['rtf'] = row['seconds']/clip['audio_seconds']
        rows_file.write(json.dumps(row,ensure_ascii=False)+'\n');rows_file.flush()
        print(json.dumps({k:row[k] for k in ('clip_id','method','repeat','seconds','last_segment_seconds','errors','text')},ensure_ascii=False),flush=True)
        return row

    try:
        for _ in range(200):
            if proc.poll() is not None:
                raise RuntimeError('LFM process exited')
            try:
                fetch('http://127.0.0.1:18096/health',timeout=1)
                break
            except OSError:
                time.sleep(.2)
        else:
            raise TimeoutError('LFM readiness')
        metadata['health']={str(port):fetch(f'http://127.0.0.1:{port}/health') for port in (18096,8089,8085)}
        # Fail visibly if the actual current backend changed.
        assert metadata['health']['8089']['model']=='granite-speech-4.1-2b'
        assert metadata['health']['8089']['backend']=='transcribe.cpp-vulkan'
        metadata['warmup']=[]
        for method in ('granite_segmented','lfm_auto_full','whisper_full_reference'):
            metadata['warmup'].append(measure(clean[0],method,-1))
            assert not metadata['warmup'][-1]['errors'],metadata['warmup'][-1]['errors']
        if args.phase in ('main','all'):
            for repeat in range(args.repeats):
                order=list(clean)
                random.Random(20261025+repeat).shuffle(order)
                for i,clip in enumerate(order):
                    methods=['granite_segmented','lfm_auto_full']
                    if (repeat+i)%2:
                        methods.reverse()
                    for method in methods:
                        measure(clip,method,repeat)
            for clip in stress:
                for method in ('granite_segmented','lfm_auto_full'):
                    measure(clip,method,0)
        if args.phase=='stress-matched':
            for clip in stress:
                measure(clip,'lfm_identical_segments',0)
            for clip in clean:
                if clip['voice']=='Zundamon':
                    measure(clip,'lfm_no_chunk_full',0)
            for clip in controls:
                measure(clip,'lfm_vad_control',0)
        if args.phase in ('diagnostics','all'):
            for clip in clean:
                for method in ('lfm_identical_segments','whisper_full_reference'):
                    measure(clip,method,0)
            # One-pass is a diagnostic, not the recommended long-audio configuration.
            for clip in clean:
                if clip['voice']=='Kasukabe_Tsumugi':
                    measure(clip,'lfm_no_chunk_full',0)
            for clip in controls:
                for method in ('granite_segmented','lfm_auto_full','whisper_full_reference'):
                    measure(clip,method,0)
            metadata['long_granite_expected_rejection']=transcribe('granite',clean[0]['audio'])
        metadata['status']='complete'
    except BaseException as exc:
        metadata['status']='failed';metadata['error']=repr(exc)
        raise
    finally:
        rows_file.close()
        metadata['after']=host()
        try:
            metadata['lfm_memory']=[l for l in Path(f'/proc/{proc.pid}/status').read_text().splitlines()
                                    if l.startswith(('VmRSS:','VmHWM:'))]
        except FileNotFoundError:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill();proc.wait()
        log.close()
        metadata['lfm_stopped']=proc.poll() is not None
        (output/'manifest.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':
    main()
