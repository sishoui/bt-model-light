#!/usr/bin/env python3
"""Repeatability test for protocol codegen.

Verifies (without mutating the working tree):
  1. Generating twice yields byte-identical output (determinism).
  2. The checked-in files match fresh generation (consistency).

Calls the generator's pure functions in-process so no files are written.
Exit 0 on success, 1 on failure.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import generate  # noqa: E402

OUT_C = generate.OUT_C
OUT_JS = generate.OUT_JS


def main() -> int:
    # Determinism: generate twice in memory.
    first_c = generate.gen_c_header()
    first_js = generate.gen_js_constants()
    second_c = generate.gen_c_header()
    second_js = generate.gen_js_constants()

    ok = True
    if first_c != second_c:
        print("FAIL: C header is not deterministic", file=sys.stderr)
        ok = False
    if first_js != second_js:
        print("FAIL: JS constants are not deterministic", file=sys.stderr)
        ok = False

    # Consistency: checked-in files must match fresh generation.
    for path, fresh in ((OUT_C, first_c), (OUT_JS, first_js)):
        if not path.exists():
            print(f"MISSING: {path.relative_to(ROOT)}", file=sys.stderr)
            ok = False
            continue
        checked_in = path.read_text(encoding="utf-8")
        if checked_in != fresh:
            print(f"DIFF: {path.relative_to(ROOT)} (checked-in != fresh generation)", file=sys.stderr)
            ok = False

    if ok:
        print("OK: codegen is deterministic and checked-in files are up to date")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())