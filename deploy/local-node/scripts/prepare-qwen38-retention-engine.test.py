from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest


validate_patch = runpy.run_path(str(Path(__file__).with_name('prepare-qwen38-retention-engine.py')))['validate_patch']


class ReviewedSourceTests(unittest.TestCase):
    def test_only_reviewed_patch_and_payloads_are_buildable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            source.mkdir()
            git = lambda *args: subprocess.check_output(['git', '-C', str(source), *args], stderr=subprocess.DEVNULL)
            git('init', '-q')
            tracked = source / 'fixture.cpp'
            tracked.write_text('before\n')
            git('add', 'fixture.cpp')
            git('-c', 'user.name=LARM fixture', '-c', 'user.email=fixture@localhost',
                '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
            tracked.write_text('reviewed\n')
            patch = root / 'reviewed.patch'
            patch.write_bytes(git('diff', 'HEAD', '--binary'))
            payload = root / 'header.h'
            payload.write_text('reviewed header\n')
            server = source / 'tools/server'
            server.mkdir(parents=True)
            header = server / 'header.h'
            header.write_bytes(payload.read_bytes())
            payloads = {'header.h': payload}
            validate_patch(source, patch, payloads)

            # Staging an unreviewed edit must not hide it from the build guard.
            tracked.write_text('unreviewed\n')
            git('add', 'fixture.cpp')
            with self.assertRaisesRegex(ValueError, 'exactly match'):
                validate_patch(source, patch, payloads)
            git('reset', '-q', 'HEAD', '--', 'fixture.cpp')
            tracked.write_text('reviewed\n')

            unexpected = source / 'unexpected.h'
            unexpected.write_text('unreviewed header\n')
            with self.assertRaisesRegex(ValueError, 'untracked'):
                validate_patch(source, patch, payloads)
            unexpected.unlink()
            header.write_text('unreviewed header\n')
            with self.assertRaisesRegex(ValueError, 'payload differs'):
                validate_patch(source, patch, payloads)
            header.write_bytes(payload.read_bytes())
            validate_patch(source, patch, payloads)


if __name__ == '__main__':
    unittest.main()
