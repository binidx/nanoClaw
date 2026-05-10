from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import NotificationConfig
from app.schemas import NotificationCreate, NotificationOut, NotificationUpdate

router = APIRouter(tags=["notifications"])


@router.get("/repos/{repo_id}/notifications", response_model=list[NotificationOut])
async def list_notifications(repo_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(NotificationConfig).where(NotificationConfig.repo_id == repo_id).order_by(NotificationConfig.id)
    )
    return result.scalars().all()


@router.post("/repos/{repo_id}/notifications", response_model=NotificationOut, status_code=201)
async def create_notification(repo_id: int, body: NotificationCreate, db: AsyncSession = Depends(get_db)):
    notif = NotificationConfig(repo_id=repo_id, **body.model_dump())
    db.add(notif)
    await db.commit()
    await db.refresh(notif)
    return notif


@router.put("/notifications/{notif_id}", response_model=NotificationOut)
async def update_notification(notif_id: int, body: NotificationUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(NotificationConfig).where(NotificationConfig.id == notif_id))
    notif = result.scalar_one_or_none()
    if not notif:
        raise HTTPException(404, "Notification config not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(notif, field, value)
    await db.commit()
    await db.refresh(notif)
    return notif


@router.delete("/notifications/{notif_id}", status_code=204)
async def delete_notification(notif_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(NotificationConfig).where(NotificationConfig.id == notif_id))
    notif = result.scalar_one_or_none()
    if not notif:
        raise HTTPException(404, "Notification config not found")
    await db.delete(notif)
    await db.commit()
