"""Builds one pure-Python wheel for the standards sandbox tests. It reads
{"out", "name", "version", "files": {path: text}, "scripts": {command:
"module:function"}} as JSON on stdin, writes the wheel into "out", and
prints its file name and sha256."""

import hashlib
import json
import pathlib
import sys
import zipfile

spec = json.load(sys.stdin)
name, version = spec["name"], spec["version"]
dist = name.replace("-", "_")
info = f"{dist}-{version}.dist-info"
files = dict(spec["files"])
files[f"{info}/METADATA"] = f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n"
files[f"{info}/WHEEL"] = "Wheel-Version: 1.0\nGenerator: standards-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
if spec.get("scripts"):
    lines = "".join(f"{command} = {target}\n" for command, target in spec["scripts"].items())
    files[f"{info}/entry_points.txt"] = f"[console_scripts]\n{lines}"
files[f"{info}/RECORD"] = "".join(f"{path},,\n" for path in [*files, f"{info}/RECORD"])
wheel = pathlib.Path(spec["out"]) / f"{dist}-{version}-py3-none-any.whl"
with zipfile.ZipFile(wheel, "w") as archive:
    for path, text in sorted(files.items()):
        archive.writestr(zipfile.ZipInfo(path, (2020, 1, 1, 0, 0, 0)), text)
print(json.dumps({"file": wheel.name, "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest()}))
