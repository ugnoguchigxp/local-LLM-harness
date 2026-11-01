import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class OnDemandKvTest(unittest.TestCase):
    def test_native_capacity_contract_and_invalid_layouts(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'policy-test'
            subprocess.run(['c++', '-std=c++17', '-UNDEBUG', '-I' + str(ROOT / 'deploy/local-node/patches'),
                            str(ROOT / 'deploy/local-node/patches/larm-on-demand-kv-test.cpp'), '-o', str(target)], check=True)
            subprocess.run([str(target)], check=True)

    def test_selector_executes_fixed_engine_on_rollback_and_requires_explicit_opt_in(self):
        loader = module('kv_launch', 'launch-on-demand-kv.py')
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            config = tmp / 'private.json'
            data = {'LARM_PROMPT_CACHE_KEY': 'a' * 64, 'LARM_PROMPT_CACHE_POLICY': '{}',
                    'LARM_CONTEXT_SLOTS': '200000,131072,131072', 'LARM_CONTEXT_DEFAULT_TOKENS': '131072', 'LARM_KV_ON_DEMAND': '0'}
            fixed, trial = tmp / 'fixed', tmp / 'trial'
            for path, label in [(fixed, 'fixed'), (trial, 'trial')]:
                path.write_text('#!/bin/sh\nprintf "' + label + ':%s" "$LARM_KV_ON_DEMAND"\n')
                path.chmod(0o700)
            config.write_text(json.dumps(data)); config.chmod(0o600)
            command = ['python3', str(ROOT / 'deploy/local-node/scripts/launch-on-demand-kv.py'), str(config), str(fixed), str(trial)]
            self.assertEqual(subprocess.check_output(command, env={**os.environ, 'LARM_KV_ON_DEMAND': '1'}, text=True), 'fixed:0')
            data['LARM_KV_ON_DEMAND'] = '1'; config.write_text(json.dumps(data))
            self.assertEqual(subprocess.check_output(command, text=True), 'trial:1')
            subprocess.run(['python3', str(ROOT / 'deploy/local-node/scripts/set-on-demand-kv-mode.py'),
                            str(config), 'fixed'], check=True, capture_output=True)
            self.assertEqual(subprocess.check_output(command, text=True), 'fixed:0')
            self.assertEqual(json.loads(config.read_text())['LARM_PROMPT_CACHE_KEY'], 'a' * 64)
            self.assertEqual(config.stat().st_mode & 0o077, 0)
            config.chmod(0o644)
            with self.assertRaises(ValueError): loader.environment(config)
            config.chmod(0o600)
            data['LARM_KV_ON_DEMAND'] = 'true'; config.write_text(json.dumps(data))
            with self.assertRaises(ValueError): loader.environment(config)

    def test_monitor_is_quiet_until_a_new_problem(self):
        monitor = module('kv_monitor', 'monitor-on-demand-kv.py')
        state = {'enabled': True, 'allocatedTokens': 200192, 'failures': 0, 'maxResizeMs': 550}
        self.assertIsNone(monitor.classify(state, None, 1000))
        self.assertIsNone(monitor.classify(state, state, 1000))
        self.assertEqual(monitor.classify({**state, 'failures': 1}, state, 1000), 'kv-resize-failed')
        self.assertEqual(monitor.classify({**state, 'maxResizeMs': 1100}, state, 1000), 'kv-resize-slow')
        self.assertEqual(monitor.classify({**state, 'allocatedTokens': 0}, state, 1000), 'unexpected-kv-capacity')
        self.assertEqual(monitor.classify({'enabled': False}, state, 1000), 'fixed-engine')
        self.assertEqual(monitor.classify(None, state, 1000), 'missing-kv-status')

    def test_monitor_unit_is_valid_as_a_user_service(self):
        subprocess.run(['systemd-analyze', '--user', 'verify',
                        str(ROOT / 'deploy/local-node/systemd/user/larm-on-demand-kv-monitor.service')], check=True)


if __name__ == '__main__':
    unittest.main()
