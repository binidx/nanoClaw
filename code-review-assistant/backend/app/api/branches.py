from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Branch
from app.schemas import BranchOut

router = APIRouter(tags=["branches"])


@router.get("/repos/{repo_id}/branches", response_model=list[BranchOut])
async def list_branches(repo_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Branch).where(Branch.repo_id == repo_id).order_by(Branch.last_commit_date.desc().nullslast())
    )
    return result.scalars().all()
