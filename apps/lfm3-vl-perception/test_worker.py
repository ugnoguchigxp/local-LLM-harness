import base64, io, json, unittest
from unittest.mock import patch
from PIL import Image
from contract import Rejected
from server import Worker

class Response:
    def __enter__(self): return io.BytesIO(json.dumps({'choices': [{'message': {'content': 'a red square'}, 'finish_reason': 'stop'}], 'usage': {'completion_tokens': 4, 'prompt_tokens': 120}, 'timings': {}}).encode())
    def __exit__(self, *args): pass

class WorkerTests(unittest.TestCase):
    def request(self):
        image = io.BytesIO(); Image.new('RGB', (32, 16), 'red').save(image, format='PNG')
        return {'model': 'lfm3-vl-2b', 'image': 'data:image/png;base64,' + base64.b64encode(image.getvalue()).decode(), 'task': 'describe', 'query': 'describe it'}

    @patch('server.urllib.request.urlopen', return_value=Response())
    def test_description_and_execution_metadata(self, call):
        result = Worker('http://127.0.0.1:1').perceive(self.request())
        self.assertEqual(result['response'], 'a red square')
        self.assertEqual(result['image']['width'], 32)
        self.assertEqual(result['detections'], [])
        self.assertEqual(result['execution']['device'], 'cpu')
        self.assertFalse(result['truncated'])
        self.assertFalse(json.loads(call.call_args.args[0].data)['chat_template_kwargs']['enable_thinking'])

    def test_unsupported_task_and_invalid_image_are_rejected(self):
        worker = Worker('http://127.0.0.1:1'); request = self.request()
        with self.assertRaises(Rejected): worker.perceive({**request, 'task': 'segmentation'})
        with self.assertRaises(Rejected): worker.perceive({**request, 'image': 'data:image/png;base64,YQ=='})

if __name__ == '__main__': unittest.main()
