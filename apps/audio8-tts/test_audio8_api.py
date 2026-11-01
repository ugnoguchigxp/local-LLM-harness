import asyncio
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import wave

import numpy as np
from fastapi.testclient import TestClient
from audio8_api import (MODEL, REVISION, NATIVE_RATE, SAMPLE_RATE, APPROVED_OUTPUT_PRESET,
                       create_app, encode_audio, read_voices, apply_output_preset,
                       InvalidGeneration, GenerationStopped)


class FakeEngine:
    default_voice = 'audio8-ja-01'
    voices = {'audio8-ja-01': {'id': 'audio8-ja-01', 'display_name': 'Test voice'}}

    def __init__(self):
        self.calls = []
        self.entered = threading.Event()
        self.proceed = threading.Event()
        self.proceed.set()
        self.error = None

    def generate(self, text, voice, cancel, deadline):
        self.calls.append((text, voice))
        self.entered.set()
        # Deliberately ignore cancellation to test that a timed-out worker retains its slot.
        if not self.proceed.wait(3):
            raise RuntimeError('worker did not complete')
        if self.error:
            raise self.error
        return .3*np.sin(2*np.pi*1000*np.arange(NATIVE_RATE)/NATIVE_RATE), NATIVE_RATE


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.client = TestClient(create_app(lambda: self.engine))
        self.client.__enter__()

    def tearDown(self):
        self.engine.proceed.set()
        self.client.__exit__(None, None, None)

    def speech(self, **fields):
        return self.client.post('/v1/audio/speech', json={'model': MODEL, 'input': 'こんにちは。', **fields})

    def test_health_and_metadata_do_not_synthesize(self):
        for path in ['/health', '/v1/models', '/v1/audio/voices?model='+MODEL]:
            self.assertEqual(self.client.get(path).status_code, 200)
        self.assertEqual(self.engine.calls, [])
        self.assertEqual(self.client.get('/health').json()['model'], MODEL)
        voice = self.client.get('/v1/audio/voices').json()['voices'][0]
        self.assertEqual(voice['capabilities']['speed'], {'minimum': 1, 'maximum': 1, 'default': 1})
        self.assertEqual(voice['styles'], [])
        self.assertEqual(self.client.get('/v1/audio/voices?model=voicevox-core').status_code, 404)

    def test_real_resampling_preserves_duration_pitch_and_pcm_metadata(self):
        wav = self.speech(speed=1, pitch_scale=0, intonation_scale=1)
        self.assertEqual(wav.status_code, 200, wav.text if wav.status_code != 200 else '')
        with wave.open(io.BytesIO(wav.content)) as f:
            self.assertEqual((f.getframerate(), f.getnchannels(), f.getsampwidth(), f.getnframes()), (24000, 1, 2, 24000))
            pcm = f.readframes(f.getnframes())
        data = np.frombuffer(pcm, dtype='<i2')
        peak_frequency = np.argmax(np.abs(np.fft.rfft(data)))
        self.assertEqual(peak_frequency, 1000)
        raw = self.speech(response_format='pcm')
        self.assertEqual(raw.content, pcm)
        self.assertIn('rate=24000', raw.headers['content-type'])
        self.assertEqual(raw.headers['x-audio-sample-rate'], '24000')
        self.assertNotIn('x-voicevox-credit', raw.headers)

    def test_unsupported_controls_never_reach_inference(self):
        for fields, status in [({'speed': 1.1}, 400), ({'pitch_scale': .03}, 400),
            ({'intonation_scale': 1.2}, 400), ({'style': 'sweet'}, 400), ({'style': 2}, 400),
            ({'stream': True}, 400), ({'instruct': 'happy'}, 400), ({'language': 'en'}, 400),
            ({'voice': 'Kasukabe_Tsumugi'}, 400), ({'voice': ''}, 400), ({'speed': True}, 422), ({'model': 'voicevox-core'}, 404),
            ({'response_format': 'mp3'}, 400), ({'input': 'あ'*151}, 400),
            ({'input': '……！？ '}, 422), ({'unexpected': True}, 422)]:
            with self.subTest(fields=fields): self.assertEqual(self.speech(**fields).status_code, status)
        self.assertEqual(self.engine.calls, [])
        self.assertEqual(self.speech(input='あ'*150).status_code, 200)

    def test_chunked_body_limit(self):
        data = json.dumps({'input': 'x'*70000}).encode()
        r = self.client.post('/v1/audio/speech', content=iter([data[:32000], data[32000:]]),
                             headers={'content-type': 'application/json'})
        self.assertEqual(r.status_code, 413)
        self.assertEqual(self.engine.calls, [])

    def test_busy_health_and_slot_recovery(self):
        self.engine.proceed.clear()
        responses = []
        t = threading.Thread(target=lambda: responses.append(self.speech()))
        t.start()
        self.assertTrue(self.engine.entered.wait(2))
        self.assertEqual(self.client.get('/health').status_code, 200)
        self.assertEqual(self.client.get('/health?fail_on_no_slot=true').status_code, 503)
        busy = self.speech()
        self.assertEqual(busy.status_code, 429)
        self.assertEqual(busy.headers['retry-after'], '1')
        self.engine.proceed.set();t.join(2)
        self.assertEqual(responses[0].status_code, 200)
        self.assertEqual(self.speech().status_code, 200)

    def test_generation_failure_releases_slot_without_exposing_input(self):
        self.engine.error = RuntimeError('private-input-marker')
        r = self.speech()
        self.assertEqual(r.status_code, 502)
        self.assertNotIn('private-input-marker', r.text)
        self.engine.error = None
        self.assertEqual(self.speech().status_code, 200)

    def test_timeout_retains_slot_until_worker_has_finished(self):
        engine = FakeEngine();engine.proceed.clear()
        with TestClient(create_app(lambda: engine, deadline_seconds=.04)) as client:
            r = client.post('/v1/audio/speech', json={'input': '確認。'})
            self.assertEqual(r.status_code, 504)
            self.assertEqual(client.get('/health?fail_on_no_slot=true').status_code, 503)
            self.assertEqual(client.post('/v1/audio/speech', json={'input': '確認。'}).status_code, 429)
            engine.proceed.set()
            for _ in range(30):
                if client.get('/health?fail_on_no_slot=true').status_code == 200: break
                time.sleep(.01)
            self.assertEqual(client.get('/health?fail_on_no_slot=true').status_code, 200)

    def test_client_disconnect_cancels_generation_without_releasing_its_live_worker(self):
        engine = FakeEngine();engine.proceed.clear()
        original = engine.generate
        seen_cancel = []
        def generate(text, voice, cancel, deadline):
            seen_cancel.append(cancel)
            return original(text, voice, cancel, deadline)
        engine.generate = generate

        async def run():
            app = create_app(lambda: engine)
            disconnected = asyncio.Event()
            first = True
            sent = []
            async def receive():
                nonlocal first
                if first:
                    first = False
                    return {'type': 'http.request', 'body': json.dumps({'input': '確認。'}).encode(), 'more_body': False}
                await disconnected.wait()
                return {'type': 'http.disconnect'}
            async def send(message): sent.append(message)
            scope = {'type': 'http', 'http_version': '1.1', 'method': 'POST', 'scheme': 'http',
                     'path': '/v1/audio/speech', 'raw_path': b'/v1/audio/speech', 'query_string': b'',
                     'headers': [(b'content-type', b'application/json')], 'client': ('127.0.0.1', 1),
                     'server': ('127.0.0.1', 8095), 'root_path': ''}
            async with app.router.lifespan_context(app):
                task = asyncio.create_task(app(scope, receive, send))
                try:
                    self.assertTrue(await asyncio.to_thread(engine.entered.wait, 1))
                    disconnected.set()
                    await asyncio.wait_for(task, 1)
                    self.assertTrue(seen_cancel[0].is_set())
                    self.assertEqual(next(m['status'] for m in sent if m['type'] == 'http.response.start'), 400)
                    health = next(r.endpoint for r in app.routes if getattr(r, 'path', '') == '/health')
                    self.assertEqual(health(True).status_code, 503)
                finally:
                    engine.proceed.set()
        asyncio.run(run())

    def test_unstarted_provider_is_unavailable(self):
        with TestClient(create_app(lambda: self.engine)) as client:
            client.app.state.engine = None
            r = client.post('/v1/audio/speech', json={'input': '確認。'})
            self.assertEqual(r.status_code, 503)
            self.assertEqual(r.headers['retry-after'], '1')
            self.assertEqual(client.get('/v1/audio/voices').status_code, 503)


class AssetAndAudioTests(unittest.TestCase):
    def test_invalid_audio_never_becomes_successful_wav(self):
        for audio, rate in [(np.array([]), NATIVE_RATE), (np.zeros((1, 10)), NATIVE_RATE),
                            (np.array([np.nan]), NATIVE_RATE), (np.zeros(500), NATIVE_RATE), (np.ones(4), 24000)]:
            with self.subTest(rate=rate):
                with self.assertRaises(InvalidGeneration): encode_audio(audio, rate, 'wav')

    def test_reference_codes_are_pinned_and_no_pickle_or_path_traversal_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp);np.save(root/'voice.npy', np.zeros((10, 8), dtype=np.int64))
            data = (root/'voice.npy').read_bytes()
            voice = {'id': 'v', 'reference_text': '参照文。', 'file': 'voice.npy', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
            manifest = {'model_revision': REVISION, 'default_voice': 'v', 'voices': [voice]}
            path = root/'manifest.json';path.write_text(json.dumps(manifest))
            self.assertEqual(read_voices(path, manifest)['default_voice'], 'v')
            with self.assertRaises(RuntimeError): read_voices(path, {**manifest, 'default_voice': 'other'})
            for change in [{'file': '../voice.npy'}, {'sha256': '0'*64}]:
                path.write_text(json.dumps({**manifest, 'voices': [{**voice, **change}]}))
                with self.assertRaises(RuntimeError): read_voices(path)
            path.write_text(json.dumps({**manifest, 'model_revision': 'wrong'}))
            with self.assertRaises(RuntimeError): read_voices(path)
            for preset in ['unreviewed-preset', {'tempo': 100}]:
                path.write_text(json.dumps({**manifest, 'voices': [{**voice, 'output_preset': preset}]}))
                with self.assertRaises(RuntimeError): read_voices(path)


class ButlerEngine(FakeEngine):
    default_voice = 'audio8-ja-butler-v1'
    voices = {
        'audio8-ja-butler-v1': {'id': 'audio8-ja-butler-v1', 'display_name': 'Butler 1.43x',
                               'output_preset': APPROVED_OUTPUT_PRESET},
        'audio8-ja-01': {'id': 'audio8-ja-01', 'display_name': 'Legacy'},
    }


@unittest.skipUnless(shutil.which('ffmpeg'), 'The approved output preset requires FFmpeg')
class ButlerPresetTests(unittest.TestCase):
    def test_default_voice_is_used_with_wav_pcm_parity_and_explicit_legacy_voice_preserved(self):
        engine = ButlerEngine()
        with TestClient(create_app(lambda: engine)) as client:
            catalog = client.get('/v1/audio/voices').json()
            self.assertEqual(catalog['default_voice'], 'audio8-ja-butler-v1')
            health = client.get('/health').json()
            self.assertEqual(health['default_output_processing']['tempo'], 1.43)
            self.assertEqual(engine.calls, [])
            response = client.post('/v1/audio/speech', json={'input': '確認。', 'speed': 1})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(engine.calls[-1][1], 'audio8-ja-butler-v1')
            with wave.open(io.BytesIO(response.content)) as wav:
                self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth()), (24000, 1, 2))
                self.assertAlmostEqual(wav.getnframes()/24000, 1/1.43, delta=.08)
                pcm = wav.readframes(wav.getnframes())
            data = np.frombuffer(pcm, dtype='<i2').astype(float)
            frequency = np.fft.rfftfreq(len(data), 1/24000)[np.argmax(np.abs(np.fft.rfft(data)))]
            self.assertAlmostEqual(frequency, 1000, delta=3)
            raw = client.post('/v1/audio/speech', json={'input': '確認。', 'response_format': 'pcm'})
            self.assertEqual(raw.content, pcm)
            legacy = client.post('/v1/audio/speech', json={'input': '確認。', 'voice': 'audio8-ja-01'})
            with wave.open(io.BytesIO(legacy.content)) as wav:
                self.assertEqual(wav.getnframes(), 24000)

    def test_chest_preset_adds_low_frequency_body_without_changing_pitch(self):
        t = np.arange(NATIVE_RATE*3)/NATIVE_RATE
        signal = .15*np.sin(2*np.pi*160*t) + .15*np.sin(2*np.pi*1400*t)
        source = np.frombuffer(encode_audio(signal, NATIVE_RATE, 'pcm')[0], dtype='<i2').astype(float)/32768
        processed = np.frombuffer(encode_audio(signal, NATIVE_RATE, 'pcm',
            output_preset=APPROVED_OUTPUT_PRESET)[0], dtype='<i2').astype(float)/32768
        self.assertAlmostEqual(len(processed)/SAMPLE_RATE, 3/1.43, delta=.08)
        self.assertLessEqual(float(np.abs(processed).max()), .951)

        def bands(data):
            data = data[4800:-4800]
            spectrum = np.abs(np.fft.rfft(data))**2
            frequency = np.fft.rfftfreq(len(data), 1/SAMPLE_RATE)
            low = spectrum[(frequency>150) & (frequency<170)].sum()
            high_band = (frequency>1390) & (frequency<1410)
            high = spectrum[high_band].sum()
            high_pitch = frequency[high_band][np.argmax(spectrum[high_band])]
            return low/high, high_pitch
        before, _ = bands(source)
        after, high_pitch = bands(processed)
        self.assertGreater(10*np.log10(after/before), 3)
        self.assertAlmostEqual(high_pitch, 1400, delta=3)

    def test_processing_failure_releases_slot_and_hides_processor_details(self):
        engine = ButlerEngine()
        with TestClient(create_app(lambda: engine)) as client:
            with patch('audio8_api.subprocess.run', return_value=subprocess.CompletedProcess(
                    [], 1, stdout=b'', stderr=b'private-processor-marker')):
                response = client.post('/v1/audio/speech', json={'input': '確認。'})
                self.assertEqual(response.status_code, 502)
                self.assertNotIn('private-processor-marker', response.text)
            self.assertEqual(client.post('/v1/audio/speech', json={'input': '確認。'}).status_code, 200)

    def test_processing_checks_cancellation_deadline_and_bad_presets(self):
        pcm = np.ones(24000, dtype='<i2').tobytes()
        cancel = threading.Event();cancel.set()
        with patch('audio8_api.subprocess.run') as run:
            with self.assertRaises(GenerationStopped):
                apply_output_preset(pcm, APPROVED_OUTPUT_PRESET, cancel=cancel)
            with self.assertRaises(GenerationStopped):
                apply_output_preset(pcm, APPROVED_OUTPUT_PRESET, deadline=time.monotonic()-1)
            run.assert_not_called()
        with self.assertRaises(InvalidGeneration): apply_output_preset(pcm, 'unknown')
        with patch('audio8_api.subprocess.run', side_effect=subprocess.TimeoutExpired('ffmpeg', 10)):
            with self.assertRaises(InvalidGeneration): apply_output_preset(pcm, APPROVED_OUTPUT_PRESET)


if __name__ == '__main__': unittest.main()
