"""
Git operations service — wraps local git commands via subprocess.
Adapted from local_git_mcp/git_ops.py.
"""

import logging
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger("code-review.git")

GIT = os.getenv("GIT_EXECUTABLE", "git")


class GitError(Exception):
    pass


def _run(args: list[str], cwd: Path, timeout: int = 120) -> str:
    cmd = [GIT] + args
    logger.debug("git %s  (cwd=%s)", " ".join(args[:6]), cwd)
    try:
        result = subprocess.run(
            cmd,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired as e:
        raise GitError(f"git command timed out ({timeout}s): {' '.join(args[:4])}") from e
    except FileNotFoundError:
        raise GitError(f"git executable not found: {GIT}")

    if result.returncode != 0:
        stderr = result.stderr.strip()[:500]
        raise GitError(f"git {args[0]} failed (rc={result.returncode}): {stderr}")

    return result.stdout


def validate_repo(local_path: str) -> bool:
    """Check if a path is a valid git repository."""
    p = Path(local_path)
    if not p.exists():
        return False
    try:
        _run(["rev-parse", "--git-dir"], cwd=p)
        return True
    except GitError:
        return False


def fetch_all(repo: Path) -> None:
    _run(["fetch", "--all", "--prune"], cwd=repo, timeout=180)


def fetch_branch(repo: Path, branch: str) -> None:
    """Fetch a specific branch from origin to get its latest commits."""
    _run(["fetch", "origin", branch], cwd=repo, timeout=120)


def list_remote_branches(repo: Path) -> list[dict[str, Any]]:
    """List all remote branches with latest commit info."""
    raw = _run(
        ["for-each-ref", "--format=%(refname:short)|%(objectname:short)|%(subject)|%(authorname)|%(authordate:iso8601)",
         "refs/remotes/origin/"],
        cwd=repo,
    )
    _skip_names = {"HEAD", "origin"}
    branches = []
    for line in raw.strip().splitlines():
        parts = line.split("|", 4)
        if len(parts) < 5:
            continue
        ref = parts[0]
        name = ref.removeprefix("origin/")
        if name in _skip_names or name.startswith("origin/"):
            continue
        commit_date = None
        try:
            commit_date = datetime.fromisoformat(parts[4].strip())
        except (ValueError, IndexError):
            pass
        branches.append({
            "name": name,
            "last_commit_hash": parts[1],
            "last_commit_message": parts[2],
            "last_commit_author": parts[3],
            "last_commit_date": commit_date,
        })
    return branches


def is_ancestor(repo: Path, ancestor_ref: str, descendant_ref: str) -> bool:
    """Check if ancestor_ref is an ancestor of descendant_ref (i.e., descendant already contains ancestor).
    This is very fast — no diff computation needed."""
    cmd = [GIT, "merge-base", "--is-ancestor", ancestor_ref, descendant_ref]
    try:
        result = subprocess.run(cmd, cwd=str(repo), capture_output=True, timeout=10)
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


def current_branch(repo: Path) -> str:
    return _run(["rev-parse", "--abbrev-ref", "HEAD"], cwd=repo).strip()


def resolve_ref(repo: Path, ref: str) -> str:
    try:
        return _run(["rev-parse", ref], cwd=repo).strip()
    except GitError:
        pass
    return _run(["rev-parse", f"origin/{ref}"], cwd=repo).strip()


def merge_base(repo: Path, ref_a: str, ref_b: str) -> str:
    return _run(["merge-base", ref_a, ref_b], cwd=repo).strip()


def diff_stat_summary(repo: Path, from_ref: str, to_ref: str) -> dict:
    raw = _run(["diff", "--shortstat", from_ref, to_ref], cwd=repo)
    text = raw.strip()
    files = added = deleted = 0
    m_files = re.search(r"(\d+) files? changed", text)
    m_add = re.search(r"(\d+) insertions?", text)
    m_del = re.search(r"(\d+) deletions?", text)
    if m_files:
        files = int(m_files.group(1))
    if m_add:
        added = int(m_add.group(1))
    if m_del:
        deleted = int(m_del.group(1))
    return {"files_changed": files, "lines_added": added, "lines_deleted": deleted}


def diff_name_status(repo: Path, from_ref: str, to_ref: str) -> list[dict[str, str]]:
    raw = _run(["diff", "--name-status", from_ref, to_ref], cwd=repo)
    result = []
    for line in raw.strip().splitlines():
        parts = line.split("\t")
        status_code = parts[0][0] if parts[0] else "M"
        status_map = {"A": "added", "M": "modified", "D": "deleted", "R": "renamed", "C": "copied"}
        entry: dict[str, str] = {
            "status": status_map.get(status_code, "modified"),
            "path": parts[-1],
        }
        if status_code == "R" and len(parts) >= 3:
            entry["old_path"] = parts[1]
            entry["path"] = parts[2]
        result.append(entry)
    return result


def diff_unified(repo: Path, from_ref: str, to_ref: str, path: str | None = None,
                 context_lines: int = 3) -> str:
    args = ["diff", f"-U{context_lines}", from_ref, to_ref]
    if path:
        args += ["--", path]
    return _run(args, cwd=repo, timeout=180)


def log_between(repo: Path, from_ref: str, to_ref: str, max_count: int = 50) -> list[dict]:
    fmt = "%H%n%h%n%an%n%aI%n%s"
    raw = _run(
        ["log", f"--max-count={max_count}", f"--format={fmt}", f"{from_ref}..{to_ref}"],
        cwd=repo,
    )
    commits: list[dict] = []
    lines = raw.strip().splitlines()
    i = 0
    while i + 4 < len(lines):
        commits.append({
            "sha": lines[i],
            "short_sha": lines[i + 1],
            "author": lines[i + 2],
            "date": lines[i + 3],
            "message": lines[i + 4],
        })
        i += 5
    return commits


def get_latest_commit(repo: Path, branch: str) -> dict | None:
    """Get the latest commit on a branch."""
    ref = branch
    try:
        _run(["rev-parse", "--verify", ref], cwd=repo)
    except GitError:
        ref = f"origin/{branch}"
        try:
            _run(["rev-parse", "--verify", ref], cwd=repo)
        except GitError:
            return None

    fmt = "%H%n%h%n%an%n%aI%n%s"
    raw = _run(["log", "-1", f"--format={fmt}", ref], cwd=repo)
    lines = raw.strip().splitlines()
    if len(lines) < 5:
        return None
    return {
        "sha": lines[0],
        "short_sha": lines[1],
        "author": lines[2],
        "date": lines[3],
        "message": lines[4],
    }


def show_file(repo: Path, ref: str, file_path: str) -> str:
    return _run(["show", f"{ref}:{file_path}"], cwd=repo, timeout=60)


def create_detached_worktree(repo: Path, ref: str) -> Path:
    """Create a temporary detached worktree at the specified ref."""
    worktree_dir = Path(tempfile.mkdtemp(prefix="cr_worktree_"))
    try:
        _run(["worktree", "add", "--detach", str(worktree_dir), ref], cwd=repo, timeout=180)
        return worktree_dir
    except Exception:
        # Best-effort cleanup if creation failed.
        try:
            if worktree_dir.exists():
                shutil.rmtree(worktree_dir, ignore_errors=True)
        except Exception:
            pass
        raise


def create_detached_worktree_at(repo: Path, ref: str, worktree_dir: Path) -> Path:
    """Create a detached worktree at a specific path."""
    try:
        worktree_dir.parent.mkdir(parents=True, exist_ok=True)
        _run(["worktree", "add", "--detach", str(worktree_dir), ref], cwd=repo, timeout=180)
        return worktree_dir
    except Exception:
        try:
            if worktree_dir.exists():
                shutil.rmtree(worktree_dir, ignore_errors=True)
        except Exception:
            pass
        raise


def remove_worktree(repo: Path, worktree_dir: Path) -> None:
    """Remove a temporary worktree; force to handle dirty/locked states."""
    try:
        _run(["worktree", "remove", "--force", str(worktree_dir)], cwd=repo, timeout=120)
    except GitError:
        # Best-effort prune stale metadata when remove fails.
        _run(["worktree", "prune"], cwd=repo, timeout=60)


def parse_diff_to_files(diff_text: str) -> list[dict]:
    """Parse a unified diff into per-file chunks."""
    file_pattern = re.compile(r"^diff --git a/(.+?) b/(.+?)$", re.MULTILINE)
    splits = file_pattern.split(diff_text)

    files = []
    i = 1
    while i + 2 < len(splits):
        old_path = splits[i]
        new_path = splits[i + 1]
        content = splits[i + 2]

        is_new = "\nnew file mode" in content
        is_deleted = "\ndeleted file mode" in content
        is_renamed = old_path != new_path

        diff_body = content.strip()
        if len(diff_body) > 8000:
            diff_body = diff_body[:8000] + "\n... (truncated)"

        files.append({
            "old_path": old_path,
            "new_path": new_path,
            "new_file": is_new,
            "deleted_file": is_deleted,
            "renamed_file": is_renamed,
            "diff": diff_body,
        })
        i += 3

    return files
