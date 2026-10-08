import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from datetime import datetime, timezone, timedelta

spec = importlib.util.spec_from_file_location("controller", Path(__file__).with_name("process-controller.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.value = {"serviceId": "fixture", "release": "fixture-v1", "manifestDigest": "a" * 64,
                      "members": [{"unit": "larm-local-service-fixture.service"}], "ports": [19876],
                      "storage": {"mountPoint": "/mnt/fixture", "dataRoot": "/mnt/fixture/data", "filesystemUuid": "expected-uuid", "minFreeBytes": 1024},
                      "writePaths": ["/mnt/fixture/data/work"], "stopSeconds": 11}
        self.props = {"ActiveState": "active", "InvocationID": "first", "ControlGroup": "/system.slice/larm-local-service-fixture.service"}

    def observe(self, pids, listener=False, props=None):
        with patch.object(c, "properties", return_value=props or self.props), patch.object(c, "group_processes", return_value=pids), patch.object(c, "listeners", return_value=listener):
            return c.observe(self.value)

    def test_running_identity_changes_across_invocations(self):
        first = self.observe({123})
        second = self.observe({123}, props={**self.props, "InvocationID": "second"})
        self.assertEqual(first["state"], "running")
        self.assertNotEqual(first["instanceToken"], second["instanceToken"])
        self.assertFalse(first["stopConfirmed"])

    def test_inactive_main_process_does_not_prove_children_or_listener_stopped(self):
        inactive = {**self.props, "ActiveState": "inactive", "ControlGroup": ""}
        self.assertFalse(self.observe({123}, props=inactive)["stopConfirmed"])
        self.assertFalse(self.observe(set(), listener=True, props=inactive)["stopConfirmed"])
        empty = self.observe(set(), props=inactive)
        self.assertTrue(empty["stopConfirmed"])
        self.assertIsNone(empty["instanceToken"])

    def test_missing_member_process_is_not_ready(self):
        self.assertNotEqual(self.observe(set())["state"], "running")

    def test_changed_cgroup_is_quarantined(self):
        with self.assertRaisesRegex(RuntimeError, "cgroup_changed"):
            self.observe({123}, props={**self.props, "ControlGroup": "/other"})

    def test_storage_refuses_uuid_ro_and_capacity(self):
        for fields, reason in [({"uuid": "wrong", "options": "rw"}, "required_storage"), ({"uuid": "expected-uuid", "options": "ro"}, "required_storage")]:
            with patch.object(c, "run", return_value=json.dumps({"filesystems": [fields]})), patch.object(c.Path, "resolve", lambda p: p):
                with self.assertRaisesRegex(RuntimeError, reason):
                    c.storage(self.value)
        with patch.object(c, "run", return_value=json.dumps({"filesystems": [{"uuid": "expected-uuid", "options": "rw"}]})), patch.object(c.Path, "resolve", lambda p: p), patch.object(c.os, "statvfs") as fs:
            fs.return_value.f_bavail = 0
            fs.return_value.f_frsize = 4096
            with self.assertRaisesRegex(RuntimeError, "storage_capacity_low"):
                c.storage(self.value)

    def test_symlink_storage_refused(self):
        with patch.object(c.Path, "resolve", return_value=Path("/wrong")):
            with self.assertRaisesRegex(RuntimeError, "storage_path_changed"):
                c.storage(self.value)

    def request(self, root, **changes):
        request = {"instanceToken": "expected", "appBootId": "app", "drainToken": "mine", "manifestDigest": "a" * 64, "requestedAt": datetime.now(timezone.utc).isoformat()}
        request.update(changes)
        path = Path(root) / "fixture.json"
        path.write_text(json.dumps(request))
        path.chmod(0o600)

    def test_stop_never_signals_replacement_wrong_app_or_external_drain(self):
        for changes in [{"instanceToken": "replacement"}, {"appBootId": "wrong"}, {"drainToken": "external"}, {"requestedAt": (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()}]:
            with tempfile.TemporaryDirectory() as root:
                self.request(root, **changes)
                with patch.object(c, "REQUEST_ROOT", Path(root)), patch.object(c, "observe", return_value={"state": "running", "instanceToken": "expected"}), patch.object(c, "activity", return_value={"draining": True, "drainToken": "mine", "bootId": "app"}), patch.object(c, "run") as control:
                    with self.assertRaises(RuntimeError):
                        c.stop(self.value)
                    control.assert_not_called()

    def test_stop_sends_parallel_unit_stop_and_confirms_empty(self):
        with tempfile.TemporaryDirectory() as root:
            self.request(root)
            observations = [{"state": "running", "instanceToken": "expected"}] * 2 + [{"stopConfirmed": True}]
            with patch.object(c, "REQUEST_ROOT", Path(root)), patch.object(c, "observe", side_effect=observations), patch.object(c, "activity", return_value={"draining": True, "drainToken": "mine", "bootId": "app"}), patch.object(c, "run") as control, patch.object(c, "publish") as publish:
                c.stop(self.value)
                self.assertEqual(control.call_args.args[0], ["/usr/bin/systemctl", "stop", "--no-block", "larm-local-service-fixture.service"])
                publish.assert_called_once()

    def test_timeout_keeps_unconfirmed_state_and_never_kills(self):
        with tempfile.TemporaryDirectory() as root:
            self.request(root)
            with patch.object(c, "REQUEST_ROOT", Path(root)), patch.object(c, "observe", return_value={"state": "running", "instanceToken": "expected", "stopConfirmed": False}), patch.object(c, "activity", return_value={"draining": True, "drainToken": "mine", "bootId": "app"}), patch.object(c, "run") as control, patch.object(c.time, "monotonic", side_effect=[0, 2]):
                with self.assertRaisesRegex(RuntimeError, "stop_unconfirmed"):
                    c.stop(self.value)
                self.assertEqual(len(control.call_args_list), 1)
                self.assertNotIn("kill", control.call_args.args[0])

    def test_storage_loss_publishes_unknown_without_releasing_capacity(self):
        with patch.object(c, "observe", return_value={"state": "running", "stopConfirmed": False}), patch.object(c, "storage", side_effect=OSError("I/O")), patch.object(c, "publish") as publish:
            c.perform(self.value, "observe")
            self.assertEqual(publish.call_args.args[1]["state"], "unknown")
            self.assertFalse(publish.call_args.args[1]["stopConfirmed"])


if __name__ == "__main__":
    unittest.main()
