"""
Sync service — fetches remote and updates the branch list in the database.
Shared by the sync button, manual review trigger, and auto-polling.
"""

import logging
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import Branch, Repository, now_cn
from app.services import git_service

logger = logging.getLogger("code-review.sync")


async def sync_repo_branches(repo_id: int, db: AsyncSession) -> int:
    """Fetch remote and sync branch list for a repo. Returns the number of branches found.
    Raises git_service.GitError on fetch failure.
    """
    result = await db.execute(
        select(Repository).where(Repository.id == repo_id)
        .options(selectinload(Repository.branches))
    )
    repo = result.scalar_one_or_none()
    if not repo:
        raise ValueError(f"Repository {repo_id} not found")

    repo_path = Path(repo.local_path)
    if not git_service.validate_repo(repo.local_path):
        raise ValueError(f"Invalid git repo: {repo.local_path}")

    git_service.fetch_all(repo_path)

    remote_branches = git_service.list_remote_branches(repo_path)

    existing = {b.name: b for b in repo.branches}
    seen_names = set()

    for rb in remote_branches:
        seen_names.add(rb["name"])
        if rb["name"] in existing:
            b = existing[rb["name"]]
            b.last_commit_hash = rb["last_commit_hash"]
            b.last_commit_message = rb["last_commit_message"]
            b.last_commit_author = rb["last_commit_author"]
            b.last_commit_date = rb["last_commit_date"]
            b.synced_at = now_cn()
        else:
            db.add(Branch(
                repo_id=repo.id,
                name=rb["name"],
                last_commit_hash=rb["last_commit_hash"],
                last_commit_message=rb["last_commit_message"],
                last_commit_author=rb["last_commit_author"],
                last_commit_date=rb["last_commit_date"],
                synced_at=now_cn(),
            ))

    for name, b in existing.items():
        if name not in seen_names:
            await db.delete(b)

    await db.commit()
    logger.info("Synced repo_id=%s: %d branches", repo_id, len(seen_names))
    return len(seen_names)
