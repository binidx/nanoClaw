import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.models import Branch, Repository, now_cn
from app.schemas import RepoCreate, RepoListItem, RepoOut, RepoUpdate, ReviewResultOut
from app.services import git_service

logger = logging.getLogger("code-review.api.repos")
router = APIRouter(tags=["repositories"])


def _build_list_item(repo: Repository) -> RepoListItem:
    polling = repo.polling_config
    return RepoListItem(
        id=repo.id,
        name=repo.name,
        language=repo.language,
        local_path=repo.local_path,
        source_type=repo.source_type,
        baseline_branch=repo.baseline_branch,
        enabled=repo.enabled,
        profile_count=len(repo.profiles),
        notification_count=len(repo.notifications),
        polling_enabled=polling.enabled if polling else False,
        polling_interval=polling.interval_minutes if polling else None,
        last_poll_at=polling.last_poll_at if polling else None,
        last_poll_status=polling.last_poll_status if polling else None,
    )


def _build_detail(repo: Repository) -> RepoOut:
    last_review = None
    if repo.reviews:
        latest = max(repo.reviews, key=lambda r: r.created_at)
        last_review = ReviewResultOut.model_validate(latest)
    return RepoOut(
        id=repo.id,
        name=repo.name,
        language=repo.language,
        local_path=repo.local_path,
        source_type=repo.source_type,
        baseline_branch=repo.baseline_branch,
        enabled=repo.enabled,
        created_at=repo.created_at,
        updated_at=repo.updated_at,
        notifications=repo.notifications,
        profiles=repo.profiles,
        polling_config=repo.polling_config,
        branch_count=len(repo.branches),
        last_review=last_review,
    )


@router.get("/repos", response_model=list[RepoListItem])
async def list_repos(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Repository)
        .options(selectinload(Repository.profiles),
                 selectinload(Repository.notifications),
                 selectinload(Repository.polling_config))
        .order_by(Repository.name)
    )
    repos = result.scalars().all()
    return [_build_list_item(r) for r in repos]


@router.post("/repos", response_model=RepoOut, status_code=201)
async def create_repo(body: RepoCreate, db: AsyncSession = Depends(get_db)):
    repo = Repository(**body.model_dump())
    db.add(repo)
    await db.commit()
    await db.refresh(repo, attribute_names=["notifications", "profiles", "polling_config", "branches", "reviews"])
    return _build_detail(repo)


@router.get("/repos/{repo_id}", response_model=RepoOut)
async def get_repo(repo_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Repository)
        .where(Repository.id == repo_id)
        .options(selectinload(Repository.notifications),
                 selectinload(Repository.profiles),
                 selectinload(Repository.polling_config),
                 selectinload(Repository.branches),
                 selectinload(Repository.reviews))
    )
    repo = result.scalar_one_or_none()
    if not repo:
        raise HTTPException(404, "Repository not found")
    return _build_detail(repo)


@router.put("/repos/{repo_id}", response_model=RepoOut)
async def update_repo(repo_id: int, body: RepoUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Repository)
        .where(Repository.id == repo_id)
        .options(selectinload(Repository.notifications),
                 selectinload(Repository.profiles),
                 selectinload(Repository.polling_config),
                 selectinload(Repository.branches),
                 selectinload(Repository.reviews))
    )
    repo = result.scalar_one_or_none()
    if not repo:
        raise HTTPException(404, "Repository not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(repo, field, value)
    repo.updated_at = now_cn()
    await db.commit()
    await db.refresh(repo)
    return _build_detail(repo)


@router.delete("/repos/{repo_id}", status_code=204)
async def delete_repo(repo_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Repository).where(Repository.id == repo_id))
    repo = result.scalar_one_or_none()
    if not repo:
        raise HTTPException(404, "Repository not found")
    await db.delete(repo)
    await db.commit()


@router.post("/repos/{repo_id}/sync")
async def sync_repo(repo_id: int, db: AsyncSession = Depends(get_db)):
    """Fetch remote and sync branch list."""
    from app.services import sync_service

    try:
        count = await sync_service.sync_repo_branches(repo_id, db)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except git_service.GitError as e:
        raise HTTPException(500, f"Git fetch failed: {e}")

    return {"message": "Sync complete", "branch_count": count}
