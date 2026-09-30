#!/usr/bin/env python3
"""Audit a Markdown knowledge base without third-party dependencies.

落地说明（2026-09-05）：docs/40-质量/quality-gates.md 与 docs/30-开发/workflow.md
把这个脚本列为**强制门禁**（`python scripts/audit_knowledge_base.py docs`，须 0 issues），
但此前仓库里并没有这个文件 —— 只有 SKILL 临时解包目录里有一份，命令按文档写法跑不起来
（死挂点：写了门禁、没有门禁）。现把零依赖实现落进 scripts/，让文档里的命令真能执行。
来源：consolidate-project-knowledge-base SKILL 的 scripts/audit_knowledge_base.py。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import unquote


LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
ID_RE = re.compile(r"^id\s*:\s*['\"]?([^'\"\s]+)", re.MULTILINE)
IGNORED_PARTS = {".git", "node_modules", "dist", "build", "__pycache__"}


def markdown_files(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*.md")
        if not any(part in IGNORED_PARTS or part.startswith(".tmp") for part in path.parts)
    )


def frontmatter(text: str) -> str | None:
    if not text.startswith("---\n") and not text.startswith("---\r\n"):
        return None
    match = re.match(r"^---\r?\n(.*?)\r?\n---(?:\r?\n|$)", text, re.DOTALL)
    return match.group(1) if match else None


def normalize_link(raw: str) -> str:
    value = raw.strip().strip("<>")
    if " " in value and not value.startswith(("./", "../")):
        value = value.split()[0]
    return unquote(value.split("#", 1)[0])


def audit(root: Path, require_frontmatter: bool = False) -> dict[str, object]:
    issues: list[dict[str, str]] = []
    ids: dict[str, list[str]] = defaultdict(list)
    files = markdown_files(root)

    for path in files:
        rel = path.relative_to(root).as_posix()
        text = path.read_text(encoding="utf-8-sig")
        meta = frontmatter(text)
        if require_frontmatter and meta is None:
            issues.append({"kind": "missing_frontmatter", "file": rel, "detail": ""})
        if meta:
            match = ID_RE.search(meta)
            if match:
                ids[match.group(1)].append(rel)

        for raw in LINK_RE.findall(text):
            target = normalize_link(raw)
            if not target or target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            if re.match(r"^[A-Za-z]:[\\/]", target) or target.startswith(("/", "\\\\")):
                issues.append({"kind": "absolute_local_link", "file": rel, "detail": raw})
                continue
            resolved = (path.parent / target).resolve()
            try:
                resolved.relative_to(root.resolve())
            except ValueError:
                issues.append({"kind": "link_outside_root", "file": rel, "detail": raw})
                continue
            if not resolved.exists():
                issues.append({"kind": "broken_link", "file": rel, "detail": raw})

    for doc_id, owners in sorted(ids.items()):
        if len(owners) > 1:
            issues.append(
                {"kind": "duplicate_id", "file": ", ".join(owners), "detail": doc_id}
            )

    return {
        "root": str(root.resolve()),
        "markdown_files": len(files),
        "ids": len(ids),
        "issues": issues,
        "status": "passed" if not issues else "failed",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="Knowledge-base root")
    parser.add_argument("--require-frontmatter", action="store_true")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    if not args.root.is_dir():
        parser.error(f"not a directory: {args.root}")
    result = audit(args.root, args.require_frontmatter)
    if args.as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(
            f"status={result['status']} files={result['markdown_files']} "
            f"ids={result['ids']} issues={len(result['issues'])}"
        )
        for issue in result["issues"]:
            print(f"{issue['kind']}: {issue['file']}: {issue['detail']}")
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
