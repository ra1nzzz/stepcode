#!/usr/bin/env python3
"""Compute basic review metrics from a JSON review session."""
from __future__ import annotations
import argparse, json
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("session")
    args = p.parse_args()
    s = json.loads(Path(args.session).read_text(encoding="utf-8"))
    changed = int(s.get("changed_files", 0))
    reviewed = int(s.get("reviewed_files", 0))
    findings = s.get("findings", [])
    confirmed = [f for f in findings if f.get("status") == "confirmed"]
    rejected = [f for f in findings if f.get("status") == "rejected"]
    verified = [f for f in findings if f.get("status") == "verified"]
    print(json.dumps({
        "coverage": (reviewed / changed) if changed else 1.0,
        "findings": len(findings),
        "confirmed": len(confirmed),
        "rejected": len(rejected),
        "verified": len(verified),
        "false_positive_rate": (len(rejected) / len(findings)) if findings else 0.0,
    }, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
