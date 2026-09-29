#!/usr/bin/env python3
"""Build a deterministic review scope manifest from a Git diff."""
from __future__ import annotations
import argparse, json, subprocess
from pathlib import Path


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True, stderr=subprocess.DEVNULL)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="HEAD^", help="Git base ref")
    p.add_argument("--head", default="HEAD", help="Git head ref")
    p.add_argument("--output", default="review-manifest.json")
    p.add_argument("--exclude", action="append", default=[])
    args = p.parse_args()

    raw = git("diff", "--name-status", f"{args.base}...{args.head}")
    files = []
    excluded = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        parts = line.split("	")
        status = parts[0]
        path = parts[-1]
        reason = next((x for x in args.exclude if path.startswith(x.rstrip("/"))), None)
        if reason:
            excluded.append({"path": path, "status": status, "reason": f"user_exclude:{reason}"})
        else:
            files.append({"path": path, "status": status})

    total = len(files) + len(excluded)
    manifest = {
        "base": args.base,
        "head": args.head,
        "changed_files": total,
        "reviewed_files": files,
        "excluded_files": excluded,
        "coverage": (len(files) / total) if total else 1.0,
    }
    Path(args.output).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "
")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
