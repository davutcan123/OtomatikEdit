"""Exercise the packaged desktop on its build host; never uses real project data."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
if sys.platform == "win32":
    executable = root / "dist" / "win-unpacked" / "OtomatikEdit.exe"
elif sys.platform == "darwin":
    matches = list((root / "dist").glob("mac*/Otomatik Edit.app/Contents/MacOS/Otomatik Edit"))
    if len(matches) != 1:
        raise SystemExit(f"Expected one packaged app, found: {matches}")
    executable = matches[0]
else:
    raise SystemExit("Desktop packaging currently targets Windows and macOS.")

env = dict(os.environ)
env.pop("ELECTRON_RUN_AS_NODE", None)
try:
    result = subprocess.run(
        [str(executable), "--smoke-test"], cwd=root, env=env,
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=240,
    )
except subprocess.TimeoutExpired as error:
    raise SystemExit(f"Packaged editor smoke test timed out: {error}") from error
print(result.stdout)
print(result.stderr, file=sys.stderr)
if result.returncode != 0 or '"ok":true' not in result.stdout:
    raise SystemExit(f"Packaged editor smoke test failed: {result.returncode}")
