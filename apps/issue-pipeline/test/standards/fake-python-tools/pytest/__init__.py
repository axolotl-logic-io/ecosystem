"""A fake `pytest` for the standards sandbox tests: `python -m pytest`
imports every test_*.py under the working folder (not .venv), runs each
test* function, and exits 1 on a failure or 5 when it finds none."""
