"""Exercise the packaged desktop on its build host; never uses real project data."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--executable", type=Path, help="Path to the installed editor executable")
args = parser.parse_args()
if args.executable is not None:
    executable = args.executable.resolve()
elif sys.platform == "win32":
    executable = root / "dist" / "win-unpacked" / "OtomatikEdit.exe"
elif sys.platform == "darwin":
    matches = list((root / "dist").glob("mac*/Otomatik Edit.app/Contents/MacOS/Otomatik Edit"))
    if len(matches) != 1:
        raise SystemExit(f"Expected one packaged app, found: {matches}")
    executable = matches[0]
else:
    raise SystemExit("Desktop packaging currently targets Windows and macOS.")

if not executable.is_file():
    raise SystemExit(f"Packaged editor executable not found: {executable}")
expected_version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
print(f"Smoke testing {executable}", flush=True)
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
if result.returncode != 0:
    raise SystemExit(f"Packaged editor smoke test exited {result.returncode}")
for line in reversed(result.stdout.splitlines()):
    try:
        report = json.loads(line)
    except json.JSONDecodeError:
        continue
    if isinstance(report, dict) and "ok" in report:
        break
else:
    raise SystemExit("Packaged editor smoke test did not report a result")
if report["ok"] is not True or report.get("packaged") is not True:
    raise SystemExit("Smoke test did not succeed in a packaged editor")
backend_version = report.get("health", {}).get("version")
desktop_version = report.get("updaterState", {}).get("currentVersion")
if backend_version != expected_version or desktop_version != expected_version:
    raise SystemExit(
        f"Expected packaged editor version {expected_version}, got backend {backend_version} and desktop {desktop_version}"
    )
