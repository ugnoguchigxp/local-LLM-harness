import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import unittest

environment = runpy.run_path(str(Path(__file__).with_name('launch-prompt-retention.py')))['environment']


class ContextLayoutTests(unittest.TestCase):
    def test_native_context_layout_bounds(self):
        compiler = shutil.which('c++')
        if not compiler: self.skipTest('C++ compiler is unavailable')
        source = Path(__file__).resolve().parents[1] / 'patches/larm-context-pools-test.cpp'
        with tempfile.TemporaryDirectory() as root:
            binary = Path(root) / 'context-pools-test'
            subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-UNDEBUG', str(source), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


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

    def test_context_pools_are_validated_and_never_inherited_accidentally(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / 'private.json'
            value = {'LARM_PROMPT_CACHE_KEY': 'a' * 64, 'LARM_PROMPT_CACHE_POLICY': '{}',
                     'LARM_CONTEXT_SLOTS': '200000,131072,131072', 'LARM_CONTEXT_DEFAULT_TOKENS': '131072'}
            p.write_text(json.dumps(value)); p.chmod(0o600)
            self.assertEqual(environment(p)['LARM_CONTEXT_SLOTS'], value['LARM_CONTEXT_SLOTS'])
            for bad in ['200000,', '0,131072', '1000001,131072', '200000, 131072']:
                p.write_text(json.dumps({**value, 'LARM_CONTEXT_SLOTS': bad}))
                with self.assertRaises(ValueError): environment(p)
            p.write_text(json.dumps({key: value[key] for key in ['LARM_PROMPT_CACHE_KEY', 'LARM_PROMPT_CACHE_POLICY']}))
            before = os.environ.get('LARM_CONTEXT_SLOTS')
            try:
                os.environ['LARM_CONTEXT_SLOTS'] = 'untrusted'
                self.assertNotIn('LARM_CONTEXT_SLOTS', environment(p))
            finally:
                if before is None: os.environ.pop('LARM_CONTEXT_SLOTS', None)
                else: os.environ['LARM_CONTEXT_SLOTS'] = before

    def test_symlink_and_noncanonical_key_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / 'private.json'
            p.write_text(json.dumps({'LARM_PROMPT_CACHE_KEY': 'not-a-secret', 'LARM_PROMPT_CACHE_POLICY': '{}'})); p.chmod(0o600)
            with self.assertRaises(ValueError): environment(p)
            link = Path(root) / 'link.json'; link.symlink_to(p)
            with self.assertRaises(OSError): environment(link)


if __name__ == '__main__':
    unittest.main()
