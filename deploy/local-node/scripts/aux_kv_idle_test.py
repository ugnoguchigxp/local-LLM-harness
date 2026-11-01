from pathlib import Path
import subprocess
import tempfile
import unittest


DEPLOYMENT = Path(__file__).resolve().parents[1]


class AuxiliaryKvIdleTest(unittest.TestCase):
    def test_inference_end_deadline_and_independent_active_slots(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp) / 'idle-clock-test'
            subprocess.run(['c++', '-std=c++17', '-UNDEBUG', '-I' + str(DEPLOYMENT / 'patches'),
                            str(DEPLOYMENT / 'patches/larm-aux-kv-idle-test.cpp'), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
