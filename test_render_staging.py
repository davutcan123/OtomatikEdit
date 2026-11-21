"""Keep live render scratch from another worker and recover after a forced exit."""
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

from render_staging import cleanup_abandoned_stages


_ROOT = Path(__file__).resolve().parent
_WORKER = """
from pathlib import Path
import subprocess
import sys
import time
from render_staging import RenderStaging

stage = RenderStaging(sys.argv[1])
(stage.path / "partial.mp4").write_bytes(b"partial")
if sys.argv[2]:
    stage.note_spawn()
    child = subprocess.Popen([sys.executable, "-c",
        "from pathlib import Path; import sys, time; stop = Path(sys.argv[1]); "
        "deadline = time.monotonic() + 15\\n"
        "while time.monotonic() < deadline and not stop.exists(): time.sleep(.025)", sys.argv[2]],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **stage.child_options())
    stage.note_child(child)
print(stage.path, flush=True)
time.sleep(15)
"""


class RenderStagingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.data = Path(temporary.name)
        self.outputs = self.data / "outputs"
        self.outputs.mkdir()

    def worker(self, child_stop=None):
        process = subprocess.Popen([sys.executable, "-c", _WORKER, str(self.outputs), str(child_stop or "")],
                                   cwd=_ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop, process)
        self.addCleanup(process.stderr.close)
        self.addCleanup(process.stdout.close)
        path = Path(process.stdout.readline().strip())
        self.assertTrue((path / "partial.mp4").is_file())
        return process, path

    @staticmethod
    def stop(process):
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)

    def test_next_launch_removes_only_abandoned_application_scratch(self):
        alive, active_path = self.worker()
        abandoned, abandoned_path = self.worker()
        self.assertNotEqual(alive.pid, abandoned.pid)
        completed = self.outputs / "out_11111111-1111-1111-1111-111111111111.mp4"
        completed.write_bytes(b"completed")
        foreign = self.outputs / (".render-" + "0" * 32)
        foreign.mkdir()
        (foreign / "foreign-media.mov").write_bytes(b"keep")
        uploads = self.data / "uploads"
        uploads.mkdir()
        original = uploads / "source.mp4"
        original.write_bytes(b"original")
        self.stop(abandoned)

        # Exercise cleanup from a separate application process, not the owner.
        subprocess.run([sys.executable, "-c",
                        "from render_staging import cleanup_abandoned_stages; "
                        "import sys; cleanup_abandoned_stages(sys.argv[1])", str(self.outputs)],
                       cwd=_ROOT, check=True, timeout=8)
        self.assertTrue((active_path / "partial.mp4").is_file())
        self.assertFalse(abandoned_path.exists())
        self.assertEqual(completed.read_bytes(), b"completed")
        self.assertEqual(original.read_bytes(), b"original")
        self.assertTrue((foreign / "foreign-media.mov").is_file())

    def test_parent_killed_before_child_ends_cannot_wipe_child_scratch(self):
        release = self.data / "release-child"
        worker, path = self.worker(release)
        self.addCleanup(release.touch)
        self.stop(worker)
        cleanup_abandoned_stages(self.outputs)
        self.assertTrue((path / "partial.mp4").is_file())
        release.touch()
        deadline = time.monotonic() + 5
        while path.exists() and time.monotonic() < deadline:
            cleanup_abandoned_stages(self.outputs)
            time.sleep(.025)
        self.assertFalse(path.exists())
