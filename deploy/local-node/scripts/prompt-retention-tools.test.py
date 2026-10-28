import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest

environment = runpy.run_path(str(Path(__file__).with_name('launch-prompt-retention.py')))['environment']


class PrivateLaunchTests(unittest.TestCase):
    def test_owner_only_environment_and_no_credential_in_argv(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / 'private.json'
            value = {'LARM_PROMPT_CACHE_KEY': 'a' * 64, 'LARM_PROMPT_CACHE_POLICY': '{}'}
            p.write_text(json.dumps(value)); p.chmod(0o600)
            env = environment(p)
            self.assertEqual(env['LARM_PROMPT_CACHE_KEY'], value['LARM_PROMPT_CACHE_KEY'])
            self.assertIn('PATH', env)
            p.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'owner-only'):
                environment(p)

    def test_symlink_and_noncanonical_key_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / 'private.json'
            p.write_text(json.dumps({'LARM_PROMPT_CACHE_KEY': 'not-a-secret', 'LARM_PROMPT_CACHE_POLICY': '{}'})); p.chmod(0o600)
            with self.assertRaises(ValueError): environment(p)
            link = Path(root) / 'link.json'; link.symlink_to(p)
            with self.assertRaises(OSError): environment(link)


if __name__ == '__main__':
    unittest.main()
