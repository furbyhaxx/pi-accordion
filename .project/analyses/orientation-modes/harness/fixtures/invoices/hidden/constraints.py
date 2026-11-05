"""Constraint checks."""
import ast
import pathlib
import sys

STDLIB = set(sys.stdlib_module_names)


def check(repo: pathlib.Path, original: pathlib.Path) -> dict:
    out = {}
    out["fixtures_untouched"] = [str(p.relative_to(repo)) for p in (repo / "tests/fixtures").rglob("*") if p.is_file() and (original / p.relative_to(repo)).read_bytes() != p.read_bytes()]
    floats = []
    for f in (repo / "export").glob("*.py"):
        for node in ast.walk(ast.parse(f.read_text())):
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "float":
                floats.append(f"{f.name}:{node.lineno}")
            if isinstance(node, ast.Constant) and isinstance(node.value, float):
                floats.append(f"{f.name}:{node.lineno} {node.value}")
    out["no_float_money"] = floats
    rates = []
    for f in (repo / "export").glob("*.py"):
        if f.name == "rates.py":
            continue
        src = f.read_text()
        for needle in ("8.1", '"19"', "'19'", "0.19", "0.081", '"CHF"', "'CHF'"):
            if needle in src:
                rates.append(f"{f.name}: {needle}")
    out["rates_in_rates_py"] = rates
    deps = []
    for f in (repo / "export").glob("*.py"):
        for node in ast.walk(ast.parse(f.read_text())):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.module and node.level == 0 else []
            for n in names:
                if n.split(".")[0] not in STDLIB and n.split(".")[0] != "export":
                    deps.append(n)
    out["stdlib_only"] = deps
    return out
    