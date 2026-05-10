import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings
from app.database import engine
from app.models import Base

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("code-review")


async def _ensure_legacy_columns():
    """Ensure newly added columns exist for existing SQLite databases."""
    async with engine.begin() as conn:
        rows = await conn.execute(text("PRAGMA table_info(review_results)"))
        columns = {r[1] for r in rows.fetchall()}
        if "review_progress" not in columns:
            await conn.execute(
                text("ALTER TABLE review_results ADD COLUMN review_progress TEXT DEFAULT '[]'")
            )
            logger.info("Added missing column review_results.review_progress")
        if "cross_run_id" not in columns:
            await conn.execute(
                text("ALTER TABLE review_results ADD COLUMN cross_run_id INTEGER")
            )
            logger.info("Added missing column review_results.cross_run_id")


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _ensure_legacy_columns()
    logger.info("Database tables created")

    from app.services.scheduler_service import scheduler_service
    await scheduler_service.start()
    logger.info("Scheduler started")

    yield

    await scheduler_service.stop()
    await engine.dispose()


app = FastAPI(title="Code Review System", lifespan=lifespan)


class ApiKeyMiddleware(BaseHTTPMiddleware):
    """Restore the API key from the X-API-Key request header.
    This keeps the backend in sync after restarts without requiring re-login."""

    async def dispatch(self, request: Request, call_next):
        key = request.headers.get("x-api-key", "").strip()
        if key and key != settings.anthropic_api_key:
            settings.anthropic_api_key = key
            from app.services.cursor_service import is_cursor_key
            if not is_cursor_key(key):
                settings.anthropic_auth_token = key
            logger.debug("API key restored from request header")
        return await call_next(request)


origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(ApiKeyMiddleware)

from app.api import auth, repos, profiles, notifications, polling, reviews, branches  # noqa: E402

app.include_router(auth.router, prefix="/api")
app.include_router(repos.router, prefix="/api")
app.include_router(profiles.router, prefix="/api")
app.include_router(notifications.router, prefix="/api")
app.include_router(polling.router, prefix="/api")
app.include_router(reviews.router, prefix="/api")
app.include_router(branches.router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok"}
