import base64, io, json, unittest
from unittest.mock import patch
from PIL import Image
from contract import Rejected
from server import Worker

class Response:
    def __init__(self, value): self.value = value
    def __enter__(self): return io.BytesIO(json.dumps(self.value).encode())
    def __exit__(self, *args): pass

COUNTS = {'contractVersion': 'llama-chat-token-count.v1', 'promptTokens': 120, 'textTokens': 56, 'imageTokens': 64, 'imageCount': 1}
RESULT = {'choices': [{'message': {'content': 'a red square'}, 'finish_reason': 'stop'}], 'usage': {'completion_tokens': 4, 'prompt_tokens': 120}, 'timings': {}}

class WorkerTests(unittest.TestCase):
    def request(self):
        image = io.BytesIO(); Image.new('RGB', (32, 16), 'red').save(image, format='PNG')
        return {'model': 'lfm3-vl-2b', 'image': 'data:image/png;base64,' + base64.b64encode(image.getvalue()).decode(), 'task': 'describe', 'query': 'describe it'}

    def test_description_and_exact_engine_metadata(self):
        for visual in (64, 80):
            counts = {**COUNTS, 'imageTokens': visual, 'textTokens': 120-visual}
            with patch('server.urllib.request.urlopen', side_effect=[Response(counts), Response(RESULT)]) as call:
                result = Worker('http://127.0.0.1:1').perceive(self.request())
            self.assertEqual(result['response'], 'a red square')
            self.assertEqual(result['image']['width'], 32)
            self.assertEqual(result['detections'], [])
            self.assertEqual(result['execution'], {'device': 'cpu', 'backend': 'llama.cpp', 'dtype': 'qad-q4_0',
                'decoderDtype': None, 'visualTokens': visual, 'outputTokens': 4, 'inputTokens': 120})
            self.assertFalse(result['truncated'])
            count_call, infer_call = [c.args[0] for c in call.call_args_list]
            self.assertTrue(count_call.full_url.endswith('/tokenize'))
            self.assertEqual(count_call.data, infer_call.data)
            self.assertFalse(json.loads(infer_call.data)['chat_template_kwargs']['enable_thinking'])

    def test_missing_invalid_or_inconsistent_measurements_fail_without_inference(self):
        cases = [{k:v for k,v in COUNTS.items() if k != 'imageTokens'}]
        cases += [{**COUNTS, **v} for v in ({'imageTokens': 0}, {'imageTokens': True}, {'imageTokens': None},
            {'textTokens': -1}, {'imageCount': 2}, {'promptTokens': 121}, {'contractVersion': 'unknown'})]
        for counts in cases:
            worker = Worker('http://127.0.0.1:1')
            with patch('server.urllib.request.urlopen', return_value=Response(counts)) as call:
                with self.assertRaises(Rejected) as error: worker.perceive(self.request())
                self.assertEqual(error.exception.code, 'execution_metadata_invalid')
                self.assertEqual(call.call_count, 1)
                self.assertFalse(worker.lock.locked())

    def test_inference_token_mismatch_fails_and_releases_worker_lock(self):
        worker = Worker('http://127.0.0.1:1')
        result = {**RESULT, 'usage': {'completion_tokens': 4, 'prompt_tokens': 119}}
        with patch('server.urllib.request.urlopen', side_effect=[Response(COUNTS), Response(result)]):
            with self.assertRaises(Rejected) as error: worker.perceive(self.request())
            self.assertEqual(error.exception.status, 502)
        self.assertFalse(worker.lock.locked())

    def test_unsupported_task_and_invalid_image_are_rejected(self):
        worker = Worker('http://127.0.0.1:1'); request = self.request()
        with self.assertRaises(Rejected): worker.perceive({**request, 'task': 'segmentation'})
        with self.assertRaises(Rejected): worker.perceive({**request, 'image': 'data:image/png;base64,YQ=='})

if __name__ == '__main__': unittest.main()
