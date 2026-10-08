#!/usr/bin/env python3
"""Reject scope expansion and unavailable storage before preparing the foundation."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("environment", Path(__file__).with_name("prepare-local-service-environment.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EnvironmentTest(unittest.TestCase):
    def test_application_installation_is_not_an_environment_policy(self):
        value = json.loads(module.CONFIG.read_text())
        for key in module.POLICY:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as temp:
                changed = json.loads(json.dumps(value))
                changed["policy"][key] = True
                path = Path(temp) / "environment.json"
                path.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    module.load(path)

    def test_failed_storage_inspection_precedes_all_writes(self):
        value = module.load(module.CONFIG)
        with patch.object(module.os, "geteuid", return_value=0), patch.object(module, "inspect", side_effect=ValueError("wrong UUID")), patch.object(module, "root_directory") as directories, patch.object(module, "fixed_file") as files:
            with self.assertRaisesRegex(ValueError, "wrong UUID"):
                module.install(value, "ugnoguchi")
            directories.assert_not_called()
            files.assert_not_called()

    def test_wrong_uuid_and_read_only_mount_rejected(self):
        value = module.load(module.CONFIG)
        for uuid, options in (("wrong", "rw"), (value["storage"]["filesystemUuid"], "ro")):
            with self.subTest(uuid=uuid, options=options):
                mount = {"filesystems": [{"target": value["storage"]["mountPoint"], "uuid": uuid, "options": options}]}
                with patch.object(module, "command", side_effect=["systemd 259", json.dumps(mount)]):
                    with self.assertRaisesRegex(ValueError, "wrong UUID"):
                        module.inspect(value)

    def test_template_has_valid_systemd_directives_without_registering_a_service(self):
        source = (module.DEPLOY / "process-member.service.in").read_text()
        fields = {"SERVICE_ID": "fixture", "MEMBER_ID": "member", "DATA_ROOT": "/tmp/larmfixture",
                  "MOUNT_UNIT": "tmp-larmfixture.mount", "APP_USER": "larm-fixture", "RELEASE_ROOT": "/tmp",
                  "PRIVATE_ROOT": "/tmp/larmfixture/private", "REGISTERED_EXEC_START": "/bin/true",
                  "STOP_SECONDS": "30", "MEMORY_MAX_BYTES": "104857600", "CPU_QUOTA_PERCENT": "100", "TASKS_MAX": "32"}
        for name, value in fields.items():
            source = source.replace(f"@{name}@", value)
        self.assertNotRegex(source, r"@[A-Z_]+@")
        with tempfile.TemporaryDirectory() as temp:
            service = Path(temp) / "larm-local-service-fixture-member.service"
            service.write_text(source)
            (Path(temp) / "tmp-larmfixture.mount").write_text("[Mount]\nWhat=tmpfs\nWhere=/tmp/larmfixture\nType=tmpfs\n")
            result = subprocess.run(["systemd-analyze", "verify", str(service)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
