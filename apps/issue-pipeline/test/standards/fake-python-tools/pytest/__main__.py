import importlib.util
import pathlib
import sys
import traceback

root = pathlib.Path.cwd()
sys.path.insert(0, str(root))
files = sorted(
    path for path in root.rglob("test_*.py") if ".venv" not in path.parts
)
ran = 0
failed = 0
for path in files:
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in sorted(dir(module)):
        if name.startswith("test") and callable(getattr(module, name)):
            ran += 1
            try:
                getattr(module, name)()
                print(f"PASSED {path.name}::{name}")
            except Exception:
                failed += 1
                print(f"FAILED {path.name}::{name}")
                traceback.print_exc()
print(f"{ran} ran, {failed} failed")
sys.exit(1 if failed else (5 if ran == 0 else 0))
