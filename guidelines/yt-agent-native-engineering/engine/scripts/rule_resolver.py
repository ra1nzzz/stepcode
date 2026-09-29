#!/usr/bin/env python3
"""Resolve review lenses from path-based rules.

Input: JSON object mapping glob patterns to lens arrays.
Output: JSON with matched patterns and effective lenses.
"""
from __future__ import annotations
import argparse, fnmatch, json
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("rules")
    p.add_argument("paths", nargs="+")
    args = p.parse_args()
    rules = json.loads(Path(args.rules).read_text(encoding="utf-8"))
    out = {}
    for path in args.paths:
        matches=[]
        lenses=[]
        for pattern, values in rules.items():
            if fnmatch.fnmatch(path, pattern):
                matches.append(pattern)
                for lens in values:
                    if lens not in lenses:
                        lenses.append(lens)
        out[path] = {"matched_rules": matches, "lenses": lenses}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
