import logging
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings
from app.services.cursor_service import is_cursor_key
from app.services import cursor_service, claude_service

logger = logging.getLogger("code-review.api.auth")
router = APIRouter(tags=["auth"])
_verified_key_expiry: dict[str, float] = {}
_KEY_VERIFY_CACHE_SECONDS = 60 * 60 * 12  # 12h


class LoginRequest(BaseModel):
    api_key: str
    username: str = ""
    password: str = ""


class LoginResponse(BaseModel):
    role: str
    message: str = ""


@router.post("/auth/login", response_model=LoginResponse)
async def login(body: LoginRequest):
    api_key = body.api_key.strip()
    if not api_key:
        raise HTTPException(400, "API Key 不能为空")

    now = time.time()
    cached_ok = _verified_key_expiry.get(api_key, 0) > now
    used_cache = False
    if is_cursor_key(api_key):
        key_label = "Cursor"
        if not cached_ok:
            verify_start = time.perf_counter()
            ok, err = await cursor_service.verify_key(api_key)
            verify_cost_ms = int((time.perf_counter() - verify_start) * 1000)
            logger.info("Cursor key verification cost=%dms", verify_cost_ms)
            if not ok:
                raise HTTPException(401, err)
            _verified_key_expiry[api_key] = now + _KEY_VERIFY_CACHE_SECONDS
        else:
            used_cache = True
    else:
        key_label = "Claude Code"
        if not cached_ok:
            verify_start = time.perf_counter()
            ok, err = await claude_service.verify_key(api_key)
            verify_cost_ms = int((time.perf_counter() - verify_start) * 1000)
            logger.info("Claude key verification cost=%dms", verify_cost_ms)
            if not ok:
                raise HTTPException(401, err)
            _verified_key_expiry[api_key] = now + _KEY_VERIFY_CACHE_SECONDS
        else:
            used_cache = True

    settings.anthropic_api_key = api_key

    role = "viewer"
    if body.username or body.password:
        if not settings.admin_username:
            raise HTTPException(401, "系统未配置管理员账号，无法以管理员身份登录")
        if body.username != settings.admin_username or body.password != settings.admin_password:
            raise HTTPException(401, "管理员账号或密码错误")
        role = "admin"

    if used_cache:
        return LoginResponse(role=role, message=f"登录成功（{key_label}，已使用缓存验证）")
    return LoginResponse(role=role, message=f"登录成功（{key_label}）")
