#!/usr/bin/env python3
"""Validate the structural contract of a YT-ANSE review finding."""
from __future__ import annotations
import argparse, json, sys

REQUIRED = ["id", "scope", "claim", "evidence", "severity", "priority"]
SCOPES = {"line", "file", "module", "system"}
PRIORITIES = {"P0", "P1", "P2"}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("file")
    args = p.parse_args()
    data = json.load(open(args.file, encoding="utf-8"))
    errors = [f"missing:{k}" for k in REQUIRED if not data.get(k)]
    if data.get("scope") not in SCOPES:
        errors.append("invalid:scope")
    if data.get("priority") not in PRIORITIES:
        errors.append("invalid:priority")
    if data.get("scope") == "line" and not data.get("path"):
        errors.append("line-scope-requires:path")
    if errors:
        print(json.dumps({"valid": False, "errors": errors}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps({"valid": True}, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
