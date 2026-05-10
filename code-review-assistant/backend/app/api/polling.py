from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import PollingConfig
from app.schemas import PollingOut, PollingUpdate

router = APIRouter(tags=["polling"])


@router.get("/repos/{repo_id}/polling", response_model=PollingOut | None)
async def get_polling(repo_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(PollingConfig).where(PollingConfig.repo_id == repo_id)
    )
    return result.scalar_one_or_none()


@router.put("/repos/{repo_id}/polling", response_model=PollingOut)
async def upsert_polling(repo_id: int, body: PollingUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(PollingConfig).where(PollingConfig.repo_id == repo_id)
    )
    config = result.scalar_one_or_none()

    if config is None:
        config = PollingConfig(repo_id=repo_id)
        db.add(config)

    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(config, field, value)

    await db.commit()
    await db.refresh(config)

    from app.services.scheduler_service import scheduler_service
    await scheduler_service.sync_job(config)

    return config
