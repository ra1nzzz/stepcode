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
import subprocess
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


def run_git(args: list[str], cwd: Path) -> str | None:
    """跑 git；不可用或失败时返回 None（跳过核对，不当成缺陷）。"""
    try:
        proc = subprocess.run(
            ["git", *args], cwd=str(cwd), check=False,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
    except (OSError, FileNotFoundError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


def check_provenance(root: Path) -> list[dict[str, str]]:
    """核对准则快照是否还等于它声称锁定的那棵上游 tree。

    存在理由：`.ohmyagent/AGENTS.md` 与 `guidelines/PROVENANCE.md` 把快照说成
    「锁定提交的只读镜像，内容与该提交的工作树一致」。这句话此前只是声明——
    没有任何检查会发现有人往快照里改一个字，而准则宪法又规定快照不可改写。
    快照目录的 Git tree 哈希是内容寻址的，所以能直接和记录里的上游 tree 比对。
    """
    issues: list[dict[str, str]] = []
    repo = root.resolve().parent if root.resolve().name == "docs" else root.resolve()
    provenance = repo / "guidelines" / "PROVENANCE.md"
    sources = root / "00-项目" / "来源并入.md"
    if not provenance.is_file() or not sources.is_file():
        return issues

    snap_dir = None
    for line in provenance.read_text(encoding="utf-8-sig").splitlines():
        m = re.search(r"快照路径[^\n|]*\|\s*`([^`]+)/`", line)
        if m:
            snap_dir = m.group(1)
            break
    if not snap_dir:
        issues.append({"kind": "provenance_unparsed", "file": "guidelines/PROVENANCE.md",
                       "detail": "读不到「快照路径」行"})
        return issues

    expected = None
    for line in sources.read_text(encoding="utf-8-sig").splitlines():
        if "mirror" not in line:
            continue
        hashes = re.findall(r"`([0-9a-f]{40})`", line)
        if snap_dir in line and len(hashes) >= 2:
            expected = hashes[-1]  # 该行顺序是 commit | tree
            break
    if expected is None:
        for line in sources.read_text(encoding="utf-8-sig").splitlines():
            hashes = re.findall(r"`([0-9a-f]{40})`", line)
            if "mirror" in line and len(hashes) >= 2:
                expected = hashes[-1]
                break
    if expected is None:
        issues.append({"kind": "provenance_unparsed", "file": "docs/00-项目/来源并入.md",
                       "detail": "读不到 mirror 行的上游 tree 哈希"})
        return issues

    actual = run_git(["rev-parse", f"HEAD:{snap_dir}"], repo)
    if actual is None:
        return issues  # 无 git 环境（例如导出后审阅），跳过而不是判红
    if actual != expected:
        issues.append({
            "kind": "snapshot_drift",
            "file": f"{snap_dir}",
            "detail": f"已提交的快照 tree {actual[:12]} ≠ 锁定的上游 tree {expected[:12]}；快照是只读镜像，改它要重新锁定并记 ADR",
        })
    # HEAD 只覆盖已提交状态：工作树里未提交的改动同样是漂移，而且是最先发生的那一步。
    dirty = run_git(["status", "--porcelain", "--", snap_dir], repo)
    if dirty:
        issues.append({
            "kind": "snapshot_dirty",
            "file": f"{snap_dir}",
            "detail": "快照工作树有未提交改动：" + "; ".join(dirty.splitlines())[:200],
        })
    return issues


def audit(root: Path, require_frontmatter: bool = False) -> dict[str, object]:
    issues: list[dict[str, str]] = []
    ids: dict[str, list[str]] = defaultdict(list)
    files = markdown_files(root)
    issues.extend(check_provenance(root))

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
