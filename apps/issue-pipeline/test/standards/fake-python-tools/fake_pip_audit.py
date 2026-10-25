"""A fake `pip-audit` for the standards sandbox tests: it prints the report
baked in beside it (report.json) as `--format json` would, exiting 1 when
it lists an advisory. It refuses to run unless PIPAPI_PYTHON_LOCATION names
the project's Python, as the assessment must point it there."""

import json
import os
import pathlib
import sys


def main():
    target = os.environ.get("PIPAPI_PYTHON_LOCATION", "")
    if not target or not os.path.exists(target):
        print(f"fake pip-audit: no project Python at {target!r}", file=sys.stderr)
        sys.exit(2)
    report = json.loads((pathlib.Path(__file__).parent / "report.json").read_text())
    print(json.dumps(report))
    found = any(dep.get("vulns") for dep in report["dependencies"])
    sys.exit(1 if found else 0)
