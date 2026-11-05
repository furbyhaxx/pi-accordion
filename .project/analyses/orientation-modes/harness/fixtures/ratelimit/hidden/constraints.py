"""Constraint checks: each returns a list of violations (empty when respected)."""
import ast
import pathlib
import sys

STDLIB = set(sys.stdlib_module_names)


def check(repo: pathlib.Path, original: pathlib.Path) -> dict:
    out = {}
    # vendor untouched
    out["vendor_untouched"] = [str(p.relative_to(repo)) for p in (repo / "vendor").rglob("*") if p.is_file() and (original / p.relative_to(repo)).read_bytes() != p.read_bytes()]
    # numbers only in config.py
    bad = []
    for f in (repo / "limiter").glob("*.py"):
        if f.name == "config.py":
            continue
        for node in ast.walk(ast.parse(f.read_text())):
            if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool) and node.value in (37, 1500, 1.5, 74, 30, 1500.0, 37.0):
                bad.append(f"{f.name}:{node.lineno} {node.value}")
    out["constants_in_config"] = bad
    # docstrings
    missing = []
    for f in (repo / "limiter").glob("*.py"):
        for node in ast.walk(ast.parse(f.read_text())):
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and not node.name.startswith("_") and ast.get_docstring(node) is None:
                missing.append(f"{f.name}:{node.name}")
    out["docstrings"] = missing
    # stdlib only
    deps = []
    for f in (repo / "limiter").glob("*.py"):
        for node in ast.walk(ast.parse(f.read_text())):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.module and node.level == 0 else []
            for n in names:
                top = n.split(".")[0]
                if top not in STDLIB and top != "limiter":
                    deps.append(f"{f.name}: {n}")
    out["stdlib_only"] = deps
    # exports unchanged
    init = (repo / "limiter/__init__.py").read_text()
    out["exports_unchanged"] = [] if '__all__ = ["TokenBucket", "check_request", "make_key"]' in init else ["limiter/__init__.py __all__ changed"]
    return out
    