"""A fake `poetry` for the standards sandbox tests (sandbox-poetry.test.ts).

It does just what the assessment asks of the real one, against the fake
index in PIP_INDEX_URL: `check --lock`, `install --no-root` (a venv at
.venv with the fake pytest), `install --only-root` (the project on that
venv's path) and `run CMD`.
"""

import os
import pathlib
import subprocess
import sys
import venv

WORK = pathlib.Path.cwd()
VENV = WORK / ".venv"
PYTHON = VENV / "bin" / "python"


def site_packages():
    found = subprocess.check_output(
        [str(PYTHON), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
        text=True,
    )
    return pathlib.Path(found.strip())


def main():
    args = sys.argv[1:]
    if args == ["check", "--lock"]:
        sys.exit(0 if (WORK / "poetry.lock").exists() else 1)
    if args == ["install", "--no-root"]:
        venv.EnvBuilder(with_pip=True).create(VENV)
        sys.exit(subprocess.call([str(PYTHON), "-m", "pip", "install", "--no-deps", "pytest"]))
    if args == ["install", "--only-root"]:
        (site_packages() / "project.pth").write_text(f"{WORK}\n")
        sys.exit(0)
    if args[:1] == ["run"]:
        command = args[1:]
        if command[:1] == ["python"]:
            command[0] = str(PYTHON)
        env = dict(os.environ, PATH=f"{VENV / 'bin'}:{os.environ.get('PATH', '')}")
        sys.exit(subprocess.call(command, env=env))
    print(f"fake poetry: unsupported {args}", file=sys.stderr)
    sys.exit(2)
