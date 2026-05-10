from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import ReviewProfile, now_cn
from app.schemas import ProfileCreate, ProfileOut, ProfileUpdate

router = APIRouter(tags=["profiles"])


@router.get("/repos/{repo_id}/profiles", response_model=list[ProfileOut])
async def list_profiles(repo_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(ReviewProfile).where(ReviewProfile.repo_id == repo_id).order_by(ReviewProfile.id)
    )
    return result.scalars().all()


@router.post("/repos/{repo_id}/profiles", response_model=ProfileOut, status_code=201)
async def create_profile(repo_id: int, body: ProfileCreate, db: AsyncSession = Depends(get_db)):
    profile = ReviewProfile(repo_id=repo_id, **body.model_dump())
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    return profile


@router.put("/profiles/{profile_id}", response_model=ProfileOut)
async def update_profile(profile_id: int, body: ProfileUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ReviewProfile).where(ReviewProfile.id == profile_id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(404, "Profile not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(profile, field, value)
    profile.updated_at = now_cn()
    await db.commit()
    await db.refresh(profile)
    return profile


@router.delete("/profiles/{profile_id}", status_code=204)
async def delete_profile(profile_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ReviewProfile).where(ReviewProfile.id == profile_id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(404, "Profile not found")
    await db.delete(profile)
    await db.commit()
