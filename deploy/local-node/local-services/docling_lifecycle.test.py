import asyncio
import importlib.util
import json
import threading
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('lifecycle', Path(__file__).with_name('docling_lifecycle.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
TOKEN = 'a' * 48


async def request(app, path, method='GET', body=None, token=TOKEN):
    output = []

    async def send(value):
        output.append(value)

    async def receive():
        return {'type': 'http.request', 'body': json.dumps(body or {}).encode()}

    await app({'type': 'http', 'path': path, 'method': method,
               'headers': [(b'authorization', f'Bearer {token}'.encode())]}, receive, send)
    return output[0]['status'], json.loads(output[-1]['body'])


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_request_finishing_during_observation_cannot_look_idle(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        scanning, complete_scan = threading.Event(), threading.Event()

        async def upstream(scope, receive, send):
            entered.set()
            await finish.wait()
            await send({'type': 'http.response.start', 'status': 200})
            await send({'type': 'http.response.body', 'body': b'{}'})

        def jobs():
            scanning.set()
            complete_scan.wait(timeout=5)
            return 0, 0, 0

        app = module.Lifecycle(upstream, TOKEN, jobs)
        work = asyncio.create_task(request(app, '/api/upload', 'POST'))
        await entered.wait()
        observation = asyncio.create_task(request(app, '/internal/larm/drain', 'POST'))
        await asyncio.to_thread(scanning.wait, 5)
        finish.set(); await work
        self.assertEqual(app.active, 0)
        complete_scan.set()
        _, snapshot = await observation
        self.assertEqual(snapshot['activeRequests'], 1)

    async def test_drain_counts_stream_until_completion_and_rejects_admission(self):
        entered, finish = asyncio.Event(), asyncio.Event()

        async def upstream(scope, receive, send):
            entered.set()
            await finish.wait()
            await send({'type': 'http.response.start', 'status': 200})
            await send({'type': 'http.response.body', 'body': b'{}'})

        app = module.Lifecycle(upstream, TOKEN, lambda: (2, 3, 1))
        work = asyncio.create_task(request(app, '/api/upload', 'POST'))
        await entered.wait()
        status, snapshot = await request(app, '/internal/larm/drain', 'POST')
        self.assertEqual(status, 200)
        self.assertEqual([snapshot[k] for k in ['queuedJobs', 'runningJobs', 'processorActiveJobs', 'activeRequests']], [2, 3, 1, 1])
        self.assertTrue(snapshot['draining'])
        self.assertEqual((await request(app, '/api/new', 'POST'))[0], 503)
        self.assertEqual((await request(app, '/internal/larm/resume', 'POST', {'drainToken': 'stale'}))[0], 409)
        self.assertEqual((await request(app, '/internal/larm/activity', token='wrong'))[0], 401)
        finish.set(); await work
        _, idle = await request(app, '/internal/larm/activity')
        self.assertEqual(idle['activeRequests'], 0)
        self.assertEqual(idle['bootId'], snapshot['bootId'])
        self.assertGreater(idle['sequence'], snapshot['sequence'])
        status, resumed = await request(app, '/internal/larm/resume', 'POST', {'drainToken': snapshot['drainToken']})
        self.assertEqual(status, 200)
        self.assertFalse(resumed['draining'])
        self.assertIsNone(resumed['drainToken'])

    async def test_unreadable_queue_is_not_idle_and_health_does_not_count(self):
        async def upstream(scope, receive, send):
            self.assertEqual(app.active, 0)
            await send({'type': 'http.response.start', 'status': 200})
            await send({'type': 'http.response.body', 'body': b'{}'})

        def unavailable():
            raise OSError('queue_unreadable')

        app = module.Lifecycle(upstream, TOKEN, unavailable)
        self.assertEqual((await request(app, '/internal/larm/activity'))[0], 503)
        self.assertEqual((await request(app, '/health/ready'))[0], 200)
        self.assertEqual(app.active, 0)

    async def test_cancelled_response_releases_counter_and_boots_are_distinct(self):
        entered = asyncio.Event()

        async def upstream(scope, receive, send):
            entered.set()
            await asyncio.Event().wait()

        app = module.Lifecycle(upstream, TOKEN, lambda: (0, 0, 0))
        work = asyncio.create_task(request(app, '/stream'))
        await entered.wait(); work.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await work
        self.assertEqual(app.active, 0)
        self.assertNotEqual(app.boot, module.Lifecycle(upstream, TOKEN, lambda: (0, 0, 0)).boot)


if __name__ == '__main__':
    unittest.main()
