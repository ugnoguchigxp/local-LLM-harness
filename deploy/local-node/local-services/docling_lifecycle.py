"""LARM lifecycle wrapper for the pinned Docling Desk application.

One uvicorn worker owns the admission gate. Keep the upstream app unmodified and
count responses until ASGI returns, including streams and background callbacks.
"""
import asyncio
import hmac
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path


class Lifecycle:
    def __init__(self, app, token, jobs):
        if len(token) < 32 or any(c.isspace() for c in token):
            raise ValueError("invalid_lifecycle_token")
        self.app, self.token, self.jobs = app, token, jobs
        self.boot = uuid.uuid4().hex
        self.sequence = 0
        self.active = 0
        self.drain_token = None

    async def reply(self, send, status, value):
        body = json.dumps(value).encode()
        await send({"type": "http.response.start", "status": status, "headers": [
            (b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
        await send({"type": "http.response.body", "body": body})

    async def snapshot(self):
        # An admitted request may enqueue a job and finish while the queue is
        # being read. Retain its busy evidence for this whole observation.
        active_before = self.active
        queued, running, processor = await asyncio.to_thread(self.jobs)
        if any(type(n) is not int or n < 0 for n in (queued, running, processor)):
            raise ValueError("invalid_activity_counts")
        self.sequence += 1
        return {"contractVersion": "larm.local-service-activity.v1", "bootId": self.boot,
                "sequence": self.sequence, "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "queuedJobs": queued, "runningJobs": running, "processorActiveJobs": processor,
                "activeRequests": max(active_before, self.active), "draining": self.drain_token is not None,
                "drainToken": self.drain_token}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]
        if path.startswith("/internal/larm/"):
            headers = dict(scope.get("headers", []))
            expected = ("Bearer " + self.token).encode()
            if not hmac.compare_digest(headers.get(b"authorization", b""), expected):
                return await self.reply(send, 401, {"error": "unauthorized"})
            method = scope["method"]
            if (path, method) not in {("/internal/larm/activity", "GET"),
                                     ("/internal/larm/drain", "POST"), ("/internal/larm/resume", "POST")}:
                return await self.reply(send, 404, {"error": "not_found"})
            if path.endswith("/drain"):
                # Set before observing jobs: concurrent admissions must fail.
                self.drain_token = self.drain_token or uuid.uuid4().hex
            if path.endswith("/resume"):
                raw = bytearray()
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    raw.extend(message.get("body", b""))
                    if len(raw) > 1024:
                        return await self.reply(send, 413, {"error": "body_too_large"})
                    if not message.get("more_body"):
                        break
                try:
                    body = json.loads(raw)
                except (ValueError, UnicodeError):
                    return await self.reply(send, 400, {"error": "invalid_body"})
                if not isinstance(body, dict) or not self.drain_token or body.get("drainToken") != self.drain_token:
                    return await self.reply(send, 409, {"error": "drain_token_mismatch"})
                self.drain_token = None
            try:
                value = await self.snapshot()
            except Exception:
                # An unavailable queue is unknown activity, never idle evidence.
                return await self.reply(send, 503, {"error": "activity_unavailable"})
            return await self.reply(send, 200, value)
        if path in {"/health/live", "/health/ready"}:
            return await self.app(scope, receive, send)
        if self.drain_token:
            return await self.reply(send, 503, {"error": "service_draining"})
        self.active += 1
        try:
            await self.app(scope, receive, send)
        finally:
            self.active -= 1


def create_app():
    from docling_desk import activity, config
    from docling_desk.app import create_app as upstream

    app = upstream()

    def jobs():
        # These counters include queued work and provider calls awaiting cancellation.
        pools = [app.state.slots, app.state.translation_manager.slots,
                 app.state.explanation_manager.slots]
        running = sum(pool.in_use for pool in pools)
        queued = 0
        knowledge = getattr(app.state, "knowledge", None)
        if knowledge is not None:
            with knowledge.store.connection(readonly=True) as db:
                counts = dict(db.execute("SELECT state,COUNT(*) FROM tasks WHERE state IN ('queued','running') GROUP BY state"))
            queued = counts.get("queued", 0)
            running += counts.get("running", 0)
        # Includes cooperating external writers; a conversion slot alone is insufficient.
        return queued, running, len(activity.live(config.DATA))

    token = Path(os.environ["LARM_DOCLING_LIFECYCLE_TOKEN_FILE"]).read_text().strip()
    return Lifecycle(app, token, jobs)
