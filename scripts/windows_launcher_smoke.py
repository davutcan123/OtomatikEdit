"""Test the Windows source launcher without installing packages or opening the editor."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    if sys.platform != "win32":
        raise SystemExit("This smoke test requires Windows and cmd.exe.")

    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="otomatik-launcher-test-") as temporary:
        fixture = Path(temporary) / "Otomatik Edit"
        fixture.mkdir()
        shutil.copyfile(root / "WINDOWS_BASLAT.bat", fixture / "WINDOWS_BASLAT.bat")
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", ".venv-windows"], cwd=fixture, check=True)
        (fixture / "windows_setup.py").write_text(
            'import sys\nraise SystemExit(0 if sys.argv[1:] == ["--check"] else 2)\n',
            encoding="utf-8",
        )
        (fixture / "app.py").write_text('print("LAUNCHER_FIXTURE_APP")\n', encoding="utf-8")
        pip_fixture = fixture / "pip"
        pip_fixture.mkdir()
        (pip_fixture / "__init__.py").touch()
        (pip_fixture / "__main__.py").write_text(
            'import os, sys\n'
            'assert sys.argv[1:] == ["install", "--prefer-binary", "-r", "requirements.txt"]\n'
            'print("LAUNCHER_FIXTURE_PIP")\n'
            'raise SystemExit(9 if os.environ["OEDIT_TEST_FAIL_PIP"] == "1" else 0)\n',
            encoding="utf-8",
        )
        requirements = fixture / "requirements.txt"
        stamp = fixture / ".req-hash"

        def digest():
            return hashlib.sha256(requirements.read_bytes()).hexdigest()

        def launch(*, pip_fails=False, expect_pip=True):
            env = {
                **os.environ,
                "OEDIT_TEST_FAIL_PIP": str(int(pip_fails)),
                "PYTHONPATH": str(fixture),
                "PIP_NO_INDEX": "1",
            }
            result = subprocess.run(
                ["cmd.exe", "/d", "/c", "WINDOWS_BASLAT.bat"],
                cwd=fixture, env=env, stdin=subprocess.DEVNULL, capture_output=True,
                encoding="utf-8", errors="replace", timeout=30,
            )
            output = result.stdout + result.stderr
            assert result.returncode == int(pip_fails), output
            assert ("LAUNCHER_FIXTURE_PIP" in output) == expect_pip, output
            assert ("LAUNCHER_FIXTURE_APP" in output) != pip_fails, output

        requirements.write_text("fixture-only==1\n", encoding="utf-8")
        launch(pip_fails=True)
        assert not stamp.exists()
        launch()
        original = digest()
        assert stamp.read_text().strip() == original
        launch(expect_pip=False)

        requirements.write_text("fixture-only==2\n", encoding="utf-8")
        launch(pip_fails=True)
        assert stamp.read_text().strip() == original
        launch()
        assert stamp.read_text().strip() == digest()
        launch(expect_pip=False)
    print("Windows launcher retries failed dependency installation without starting the editor or updating the hash.")


if __name__ == "__main__":
    main()
