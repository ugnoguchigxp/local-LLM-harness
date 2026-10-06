"""Exercise fail-closed deployment control without a Docker installation."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("controller", Path(__file__).with_name("controller.py"))
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "compose.yaml").write_text("services: {}\n")
        (self.root / "images.env").write_text(
            "LARM_DOCLING_API_IMAGE=sha256:" + "a" * 64 + "\n"
            "LARM_DOCLING_PROCESSOR_IMAGE=sha256:" + "b" * 64 + "\n"
        )
        for name, value in (("ROOT", self.root), ("STATE", self.root / "observed.json")):
            p = patch.object(controller, name, value)
            p.start()
            self.addCleanup(p.stop)

    def row(self, service="api", running=False):
        return {"Id": "a" * 64, "Config": {"Labels": {
            "io.larm.service": "docling-desk", "io.larm.release": controller.RELEASE,
            "com.docker.compose.service": service,
        }}, "State": {"Running": running, "ExitCode": 0}}

    def run_for(self, rows):
        def run(args, **_):
            if args[1] == "ps":
                return "\n".join(row["Id"] for row in rows)
            if args[1] == "inspect":
                return json.dumps(rows)
            raise AssertionError(args)
        return run

    def test_stopped_observation_is_fresh_and_bound_to_manifest(self):
        with patch.object(controller, "run", self.run_for([self.row()])):
            value = controller.observe()
        self.assertEqual(value["state"], "stopped")
        self.assertEqual(value["containerIds"], [])
        self.assertTrue(value["observedAt"].endswith("Z"))
        self.assertEqual(value["manifestDigest"], controller.manifest_digest())
        self.assertEqual(json.loads(controller.STATE.read_text()), value)

    def test_unowned_group_does_not_replace_prior_observation(self):
        controller.STATE.write_text("prior")
        row = self.row()
        row["Config"]["Labels"]["io.larm.release"] = "other"
        with patch.object(controller, "run", self.run_for([row])):
            with self.assertRaisesRegex(RuntimeError, "unowned_container"):
                controller.observe()
        self.assertEqual(controller.STATE.read_text(), "prior")

    def test_partial_group_is_failed_and_accounts_anonymous_memory(self):
        class Reply:
            status = 200
            def read(self, _):
                return b'{"memory_stats":{"stats":{"anon":123,"file":999}}}'
        with patch.object(controller, "run", self.run_for([self.row(running=True)])), \
             patch.object(controller.socket, "socket"), \
             patch.object(controller.http.client, "HTTPConnection") as connection:
            connection.return_value.getresponse.return_value = Reply()
            value = controller.observe()
        self.assertEqual(value["state"], "failed")
        self.assertEqual(value["memoryUsageBytes"], 123)

    def test_preflight_rejects_rootful_and_changed_manifest(self):
        (self.root / "manifest.sha256").write_text(controller.manifest_digest())
        info = {"SecurityOptions": ["name=rootless"], "CgroupVersion": "2", "CgroupDriver": "systemd"}
        with patch.object(controller.sys, "argv", ["controller", "preflight"]), \
             patch.object(controller, "compose") as compose, \
             patch.object(controller, "run", return_value=json.dumps(info)) as run:
            controller.main()
            compose.assert_called_once_with("config", "--quiet")
            (self.root / "compose.yaml").write_text("services: {changed: {}}")
            with self.assertRaisesRegex(RuntimeError, "deployment_digest_changed"):
                controller.main()
            run.return_value = json.dumps({**info, "SecurityOptions": []})
            with self.assertRaisesRegex(RuntimeError, "rootless_cgroup_required"):
                controller.main()

    def test_busy_application_cannot_receive_term(self):
        with patch.object(controller.sys, "argv", ["controller", "stop"]), \
             patch.object(controller, "observe", return_value={"state": "running", "containerIds": ["a" * 64, "b" * 64]}), \
             patch.object(controller, "activity", side_effect=RuntimeError("service_busy")), \
             patch.object(controller, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "service_busy"):
                controller.main()
            run.assert_not_called()

    def test_stop_timeout_only_sends_term_and_never_force_kills(self):
        calls = []
        def run(args, **_):
            calls.append(args)
            return json.dumps([self.row(running=True)]) if args[1] == "inspect" else ""
        with patch.object(controller.sys, "argv", ["controller", "stop"]), \
             patch.object(controller, "observe", return_value={"state": "running", "containerIds": ["a" * 64, "b" * 64]}), \
             patch.object(controller, "activity"), \
             patch.object(controller, "compose", return_value="a" * 64), \
             patch.object(controller, "run", run), \
             patch.object(controller.time, "monotonic", side_effect=[0, 61]):
            with self.assertRaisesRegex(RuntimeError, "stop_timeout"):
                controller.main()
        self.assertEqual(calls[0], ["/usr/bin/docker", "kill", "--signal", "TERM", "a" * 64])
        self.assertEqual(len(calls), 2)

    def test_existing_running_group_cannot_be_adopted_by_start(self):
        with patch.object(controller.sys, "argv", ["controller", "start"]), \
             patch.object(controller, "observe", return_value={"state": "running", "containerIds": ["a" * 64, "b" * 64]}), \
             patch.object(controller, "compose") as compose:
            with self.assertRaisesRegex(RuntimeError, "group_quarantined"):
                controller.main()
            compose.assert_not_called()

    def test_fully_exited_failed_group_can_be_reset_and_started(self):
        with patch.object(controller, "observe", return_value={"state": "failed", "containerIds": []}), \
             patch.object(controller, "activity") as activity, \
             patch.object(controller, "compose") as compose:
            controller.perform("stop")
            activity.assert_not_called()
            controller.perform("start")
            compose.assert_called_once()

    def test_observer_skips_snapshot_while_control_holds_lock(self):
        import fcntl
        with (controller.STATE.parent / ".controller.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with patch.object(controller.sys, "argv", ["controller", "observe"]), \
                 patch.object(controller, "observe") as observe:
                controller.main()
                observe.assert_not_called()


if __name__ == "__main__":
    unittest.main()
