import asyncio
import json
import logging
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db, async_session
from app.models import Branch, CrossRepoReviewRun, TZ_CN, Repository, ReviewProfile, ReviewResult, now_cn
from app.schemas import (
    CrossRepoProfileOptionOut,
    CrossRepoPaginatedOut,
    CrossRepoQueueStatusOut,
    CrossRepoReviewDetailOut,
    CrossRepoReviewRunOut,
    CrossRepoReviewTrigger,
    PaginatedReviews,
    ReviewQueueStatusOut,
    ReviewResultOut,
    ReviewTrigger,
    TriggerReviewResponse,
)
from app.services import git_service, review_service, review_trace_log

STALE_BRANCH_DAYS = 5


def _stale_cutoff():
    """Return a timezone-aware cutoff datetime for filtering stale branches."""
    return datetime.now(TZ_CN) - timedelta(days=STALE_BRANCH_DAYS)

logger = logging.getLogger("code-review.api.reviews")
router = APIRouter(tags=["reviews"])

# prevent background tasks from being garbage collected
_background_tasks: set[asyncio.Task] = set()
_review_workers: set[asyncio.Task] = set()
_review_queue: asyncio.Queue[dict] = asyncio.Queue()
_repo_locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
_queued_review_ids: deque[int] = deque()
_active_review_ids: set[int] = set()
_queue_state_lock = asyncio.Lock()
REVIEW_QUEUE_MAX_CONCURRENCY = 2
_cross_review_workers: set[asyncio.Task] = set()
_cross_review_queue: asyncio.Queue[dict] = asyncio.Queue()
_queued_cross_run_ids: deque[int] = deque()
_active_cross_run_ids: set[int] = set()
_cross_queue_state_lock = asyncio.Lock()
CROSS_REVIEW_MAX_CONCURRENCY = 1
HEARTBEAT_INTERVAL_SECONDS = 60


def _repo_key(local_path: str) -> str:
    return str(Path(local_path).resolve()).lower()


def _get_repo_lock(local_path: str) -> asyncio.Lock:
    return _repo_locks[_repo_key(local_path)]


def _build_progress_event(stage: str, message: str, level: str = "info") -> dict:
    return {
        "time": now_cn().isoformat(timespec="seconds"),
        "stage": stage,
        "message": message,
        "level": level,
    }


def _parse_progress(text: str | None) -> list[dict]:
    if not text:
        return []
    try:
        data = json.loads(text)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _append_progress(record: ReviewResult, stage: str, message: str, level: str = "info") -> None:
    events = _parse_progress(record.review_progress)
    events.append(_build_progress_event(stage=stage, message=message, level=level))
    # keep recent events only
    if len(events) > 120:
        events = events[-120:]
    record.review_progress = json.dumps(events, ensure_ascii=False)


def _append_cross_progress(run: CrossRepoReviewRun, stage: str, message: str, level: str = "info") -> None:
    events = _parse_progress(run.review_progress)
    events.append(_build_progress_event(stage=stage, message=message, level=level))
    if len(events) > 200:
        events = events[-200:]
    run.review_progress = json.dumps(events, ensure_ascii=False)


def _sanitize_stream_chunk(chunk: str) -> str:
    if not chunk:
        return ""
    text = chunk.replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(ch for ch in text if ch == "\n" or ch == "\t" or ord(ch) >= 32)
    text = text.strip()
    if len(text) > 1200:
        text = text[-1200:]
    return text


def _is_review_terminal(status: str) -> bool:
    return status in {"passed", "failed", "error"}


async def _ensure_review_workers() -> None:
    alive = {t for t in _review_workers if not t.done()}
    _review_workers.clear()
    _review_workers.update(alive)
    if _review_workers:
        return
    for idx in range(REVIEW_QUEUE_MAX_CONCURRENCY):
        task = asyncio.create_task(_review_worker(idx))
        _review_workers.add(task)
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
    logger.info("Review workers started: concurrency=%d", REVIEW_QUEUE_MAX_CONCURRENCY)


async def _enqueue_review_job(
    *,
    review_id: int,
    local_path: str,
    baseline: str,
    target_ref: str,
    profile_id: int | None,
) -> None:
    async with _queue_state_lock:
        _queued_review_ids.append(review_id)
    await _review_queue.put(
        {
            "review_id": review_id,
            "local_path": local_path,
            "baseline": baseline,
            "target_ref": target_ref,
            "profile_id": profile_id,
        }
    )


async def _mark_job_started(review_id: int) -> None:
    async with _queue_state_lock:
        try:
            _queued_review_ids.remove(review_id)
        except ValueError:
            pass
        _active_review_ids.add(review_id)


async def _mark_job_finished(review_id: int) -> None:
    async with _queue_state_lock:
        _active_review_ids.discard(review_id)
        try:
            _queued_review_ids.remove(review_id)
        except ValueError:
            pass


async def _get_queue_status_snapshot(review_id: int) -> dict:
    async with _queue_state_lock:
        queued = list(_queued_review_ids)
        active = set(_active_review_ids)
    in_queue = review_id in queued
    return {
        "review_id": review_id,
        "in_queue": in_queue,
        "executing": review_id in active,
        "queue_position": (queued.index(review_id) + 1) if in_queue else 0,
        "queued_total": len(queued),
        "active_total": len(active),
        "max_concurrency": REVIEW_QUEUE_MAX_CONCURRENCY,
    }


async def _ensure_cross_review_workers() -> None:
    alive = {t for t in _cross_review_workers if not t.done()}
    _cross_review_workers.clear()
    _cross_review_workers.update(alive)
    if _cross_review_workers:
        return
    for idx in range(CROSS_REVIEW_MAX_CONCURRENCY):
        task = asyncio.create_task(_cross_review_worker(idx))
        _cross_review_workers.add(task)
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
    logger.info("Cross review workers started: concurrency=%d", CROSS_REVIEW_MAX_CONCURRENCY)


async def _enqueue_cross_review_job(
    *,
    run_id: int,
    branch_name: str,
    repos: list[dict],
    profile_instruction: str = "",
) -> None:
    async with _cross_queue_state_lock:
        _queued_cross_run_ids.append(run_id)
    await _cross_review_queue.put(
        {
            "run_id": run_id,
            "branch_name": branch_name,
            "repos": repos,
            "profile_instruction": profile_instruction,
        }
    )


async def _mark_cross_job_started(run_id: int) -> None:
    async with _cross_queue_state_lock:
        try:
            _queued_cross_run_ids.remove(run_id)
        except ValueError:
            pass
        _active_cross_run_ids.add(run_id)


async def _mark_cross_job_finished(run_id: int) -> None:
    async with _cross_queue_state_lock:
        _active_cross_run_ids.discard(run_id)
        try:
            _queued_cross_run_ids.remove(run_id)
        except ValueError:
            pass


async def _get_cross_queue_status_snapshot(run_id: int) -> dict:
    async with _cross_queue_state_lock:
        queued = list(_queued_cross_run_ids)
        active = set(_active_cross_run_ids)
    in_queue = run_id in queued
    return {
        "run_id": run_id,
        "in_queue": in_queue,
        "executing": run_id in active,
        "queue_position": (queued.index(run_id) + 1) if in_queue else 0,
        "queued_total": len(queued),
        "active_total": len(active),
        "max_concurrency": CROSS_REVIEW_MAX_CONCURRENCY,
    }


async def get_runtime_queue_snapshot() -> dict[str, set[int]]:
    """Expose in-memory queue/runtime states for watchdog checks."""
    async with _queue_state_lock:
        single_queued = set(_queued_review_ids)
        single_active = set(_active_review_ids)
    async with _cross_queue_state_lock:
        cross_queued = set(_queued_cross_run_ids)
        cross_active = set(_active_cross_run_ids)
    return {
        "single_queued": single_queued,
        "single_active": single_active,
        "cross_queued": cross_queued,
        "cross_active": cross_active,
    }


@router.get("/repos/{repo_id}/reviews", response_model=PaginatedReviews)
async def list_reviews(
    repo_id: int,
    page: int = 1,
    page_size: int = 10,
    db: AsyncSession = Depends(get_db),
):
    page_size = min(max(page_size, 1), 100)
    page = max(page, 1)
    offset = (page - 1) * page_size

    count_result = await db.execute(
        select(func.count()).select_from(ReviewResult).where(ReviewResult.repo_id == repo_id)
    )
    total = count_result.scalar() or 0

    result = await db.execute(
        select(ReviewResult)
        .where(ReviewResult.repo_id == repo_id)
        .order_by(ReviewResult.created_at.desc())
        .offset(offset)
        .limit(page_size)
    )
    return PaginatedReviews(items=result.scalars().all(), total=total, page=page, page_size=page_size)


@router.delete("/repos/{repo_id}/reviews", status_code=200)
async def clear_reviews(repo_id: int, db: AsyncSession = Depends(get_db)):
    """Delete all review records for a repo."""
    result = await db.execute(
        select(func.count()).select_from(ReviewResult).where(ReviewResult.repo_id == repo_id)
    )
    total = result.scalar() or 0
    await db.execute(
        ReviewResult.__table__.delete().where(ReviewResult.repo_id == repo_id)
    )
    await db.commit()
    return {"deleted": total}


@router.get("/reviews/{review_id}", response_model=ReviewResultOut)
async def get_review(review_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(ReviewResult).where(ReviewResult.id == review_id)
    )
    review = result.scalar_one_or_none()
    if not review:
        raise HTTPException(404, "Review not found")
    return review


@router.get("/reviews/{review_id}/queue-status", response_model=ReviewQueueStatusOut)
async def get_review_queue_status(review_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ReviewResult).where(ReviewResult.id == review_id))
    review = result.scalar_one_or_none()
    if not review:
        raise HTTPException(404, "Review not found")
    snapshot = await _get_queue_status_snapshot(review_id)
    return ReviewQueueStatusOut(
        review_id=review_id,
        status=review.status,
        in_queue=snapshot["in_queue"],
        executing=snapshot["executing"],
        queue_position=snapshot["queue_position"],
        queued_total=snapshot["queued_total"],
        active_total=snapshot["active_total"],
        max_concurrency=snapshot["max_concurrency"],
    )


@router.get("/cross-repo-runs", response_model=CrossRepoPaginatedOut)
@router.get("/reviews/cross-repo", response_model=CrossRepoPaginatedOut)
async def list_cross_repo_reviews(
    page: int = 1,
    page_size: int = 10,
    db: AsyncSession = Depends(get_db),
):
    page_size = min(max(page_size, 1), 100)
    page = max(page, 1)
    offset = (page - 1) * page_size

    count_result = await db.execute(select(func.count()).select_from(CrossRepoReviewRun))
    total = count_result.scalar() or 0

    result = await db.execute(
        select(CrossRepoReviewRun)
        .order_by(CrossRepoReviewRun.created_at.desc())
        .offset(offset)
        .limit(page_size)
    )
    runs = result.scalars().all()
    return CrossRepoPaginatedOut(
        items=[CrossRepoReviewRunOut.model_validate(r) for r in runs],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/cross-repo-branches", response_model=list[str])
@router.get("/reviews/cross-repo/branch-hints", response_model=list[str])
async def search_cross_repo_branches(
    q: str = "",
    limit: int = 30,
    db: AsyncSession = Depends(get_db),
):
    keyword = (q or "").strip()
    limit = min(max(limit, 1), 100)
    stmt = select(Branch.name).join(Repository, Branch.repo_id == Repository.id).where(Repository.enabled == True)  # noqa: E712
    if keyword:
        stmt = stmt.where(Branch.name.like(f"%{keyword}%"))
    # Fetch more rows first, then de-duplicate by trimmed branch name.
    # Case-sensitive: feature/A and feature/a should both be kept.
    stmt = stmt.order_by(Branch.name.asc()).limit(limit * 5)
    res = await db.execute(stmt)
    names = [str(r[0]) for r in res.all() if r and r[0]]
    uniq: list[str] = []
    seen: set[str] = set()
    for name in names:
        norm = name.strip()
        if not norm or norm in seen:
            continue
        seen.add(norm)
        uniq.append(name.strip())
        if len(uniq) >= limit:
            break
    return uniq


@router.get("/cross-repo-profile-options", response_model=list[CrossRepoProfileOptionOut])
async def list_cross_repo_profile_options(db: AsyncSession = Depends(get_db)):
    stmt = (
        select(ReviewProfile, Repository)
        .join(Repository, ReviewProfile.repo_id == Repository.id)
        .where(Repository.enabled == True, ReviewProfile.enabled == True)  # noqa: E712
        .order_by(Repository.name.asc(), ReviewProfile.name.asc())
    )
    res = await db.execute(stmt)
    rows = res.all()
    return [
        CrossRepoProfileOptionOut(
            id=profile.id,
            repo_id=repo.id,
            repo_name=repo.name,
            name=profile.name,
            enabled=profile.enabled,
        )
        for profile, repo in rows
    ]


@router.post("/reviews/cross-repo", response_model=CrossRepoReviewDetailOut, status_code=201)
async def trigger_cross_repo_review(body: CrossRepoReviewTrigger, db: AsyncSession = Depends(get_db)):
    branch_name = body.branch_name.strip()
    if not branch_name:
        raise HTTPException(400, "branch_name 不能为空")

    repo_res = await db.execute(
        select(Repository)
        .where(Repository.enabled == True)  # noqa: E712
        .order_by(Repository.name.asc())
    )
    repos = repo_res.scalars().all()
    if not repos:
        raise HTTPException(404, "没有可用仓库")

    from app.services import sync_service
    candidates: list[dict] = []
    skipped_reasons: list[str] = []
    for repo in repos:
        if not git_service.validate_repo(repo.local_path):
            skipped_reasons.append(f"{repo.name}: 本地路径不是有效 Git 仓库")
            continue
        try:
            await sync_service.sync_repo_branches(repo.id, db)
        except Exception as e:
            logger.warning("Cross-review sync skipped repo=%s err=%s", repo.name, e)
            skipped_reasons.append(f"{repo.name}: 同步远端分支失败（{e}）")
            continue
        branch_exists_res = await db.execute(
            select(Branch.id).where(Branch.repo_id == repo.id, Branch.name == branch_name).limit(1)
        )
        if branch_exists_res.scalar_one_or_none() is None:
            skipped_reasons.append(f"{repo.name}: 未找到分支 {branch_name}")
            continue
        candidates.append(
            {
                "repo_id": repo.id,
                "repo_name": repo.name,
                "local_path": repo.local_path,
                "baseline_branch": repo.baseline_branch,
                "target_ref": f"origin/{branch_name}",
            }
        )

    if not candidates:
        reason_text = "；".join(skipped_reasons[:8]) if skipped_reasons else "无可用候选仓库"
        raise HTTPException(400, f"未找到包含分支 {branch_name} 且可审查的仓库。{reason_text}")
    if len(candidates) < 2:
        reason_text = "；".join(skipped_reasons[:8]) if skipped_reasons else "仅有 1 个仓库匹配该分支"
        raise HTTPException(
            400,
            f"跨仓联合审查至少需要 2 个仓库，当前仅匹配 {len(candidates)} 个（{candidates[0]['repo_name']}）。{reason_text}",
        )
    matched_repo_names = [str(c.get("repo_name") or "") for c in candidates if c.get("repo_name")]

    selected_profile_ids = sorted(
        {*(body.profile_ids or []), *([body.profile_id] if body.profile_id else [])}
    )
    selected_profiles: list[ReviewProfile] = []
    if selected_profile_ids:
        prof_res = await db.execute(
            select(ReviewProfile).where(
                ReviewProfile.id.in_(selected_profile_ids),
                ReviewProfile.enabled == True,  # noqa: E712
            )
        )
        selected_profiles = prof_res.scalars().all()
        if not selected_profiles:
            raise HTTPException(400, "未找到可用的 Profile，请重新选择")

    run = CrossRepoReviewRun(
        branch_name=branch_name,
        status="reviewing",
        started_at=now_cn(),
        summary=f"跨仓库联审已创建，目标分支：{branch_name}",
        review_progress=json.dumps(
            [
                _build_progress_event("queued", f"已匹配 {len(candidates)} 个仓库，等待统一审查"),
                _build_progress_event("matched_repos", ", ".join(matched_repo_names)),
            ],
            ensure_ascii=False,
        ),
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    review_trace_log.write_review_event(
        "cross",
        run.id,
        "run_created",
        {
            "branch_name": branch_name,
            "matched_repos": matched_repo_names,
            "selected_profile_ids": selected_profile_ids,
        },
    )

    await _ensure_cross_review_workers()
    profile_instruction = ""
    if selected_profiles:
        chunks = []
        for p in selected_profiles:
            tpl = (p.prompt_template or "").strip()
            if not tpl:
                continue
            chunks.append(f"- Profile#{p.id} {p.name}:\n{tpl}")
        if chunks:
            profile_instruction = "请同时遵循以下 Profile 审查要求：\n" + "\n\n".join(chunks)

    await _enqueue_cross_review_job(
        run_id=run.id,
        branch_name=branch_name,
        repos=candidates,
        profile_instruction=profile_instruction,
    )
    _append_cross_progress(run, "queued", "联审总任务已入队（不再执行子仓库独立审查）")
    await db.commit()

    return CrossRepoReviewDetailOut(
        run=CrossRepoReviewRunOut.model_validate(run),
        children=[],
    )


@router.get("/reviews/cross-repo/{run_id}", response_model=CrossRepoReviewDetailOut)
async def get_cross_repo_review(run_id: int, db: AsyncSession = Depends(get_db)):
    run_res = await db.execute(select(CrossRepoReviewRun).where(CrossRepoReviewRun.id == run_id))
    run = run_res.scalar_one_or_none()
    if not run:
        raise HTTPException(404, "Cross review run not found")

    child_res = await db.execute(
        select(ReviewResult)
        .where(ReviewResult.cross_run_id == run_id)
        .order_by(ReviewResult.created_at.asc())
    )
    children = child_res.scalars().all()
    return CrossRepoReviewDetailOut(
        run=CrossRepoReviewRunOut.model_validate(run),
        children=[ReviewResultOut.model_validate(c) for c in children],
    )


@router.get("/reviews/cross-repo/{run_id}/queue-status", response_model=CrossRepoQueueStatusOut)
async def get_cross_repo_queue_status(run_id: int, db: AsyncSession = Depends(get_db)):
    run_res = await db.execute(select(CrossRepoReviewRun).where(CrossRepoReviewRun.id == run_id))
    run = run_res.scalar_one_or_none()
    if not run:
        raise HTTPException(404, "Cross review run not found")

    snapshot = await _get_cross_queue_status_snapshot(run_id)
    children_count_res = await db.execute(
        select(func.count()).select_from(ReviewResult).where(ReviewResult.cross_run_id == run_id)
    )
    children_done_res = await db.execute(
        select(func.count()).select_from(ReviewResult).where(
            ReviewResult.cross_run_id == run_id,
            ReviewResult.status.in_(["passed", "failed", "error"]),
        )
    )
    persisted_children_total = int(children_count_res.scalar() or 0)
    persisted_children_done = int(children_done_res.scalar() or 0)
    matched_total = 0
    for evt in _parse_progress(run.review_progress):
        if evt.get("stage") == "matched_repos" and evt.get("message"):
            matched_total = len([x for x in str(evt["message"]).split(",") if x.strip()])
            break
    total_children = max(persisted_children_total, matched_total, 1)
    done_total = persisted_children_done
    if run.status in {"passed", "failed", "error"}:
        done_total = max(done_total, total_children)

    return CrossRepoQueueStatusOut(
        run_id=run_id,
        status=run.status,
        queued_total=snapshot["queued_total"],
        active_total=snapshot["active_total"],
        done_total=done_total,
        total_children=total_children,
        max_concurrency=snapshot["max_concurrency"],
    )


async def _execute_cross_run(
    run_id: int,
    branch_name: str,
    repos: list[dict],
    profile_instruction: str = "",
) -> None:
    logger.info("Cross review starting: run_id=%s branch=%s repos=%d", run_id, branch_name, len(repos))
    heartbeat_task: asyncio.Task | None = None
    try:
        async with async_session() as db:
            run_res = await db.execute(select(CrossRepoReviewRun).where(CrossRepoReviewRun.id == run_id))
            run = run_res.scalar_one_or_none()
            if not run:
                return
            _append_cross_progress(run, "start", f"联审开始执行，共 {len(repos)} 个仓库")
            run.summary = f"跨仓库联审进行中：正在分析 {len(repos)} 个仓库"
            await db.commit()

        async def _cross_heartbeat():
            try:
                while True:
                    await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
                    async with async_session() as hdb:
                        hres = await hdb.execute(
                            select(CrossRepoReviewRun).where(CrossRepoReviewRun.id == run_id)
                        )
                        hrun = hres.scalar_one_or_none()
                        if not hrun or hrun.status != "reviewing":
                            return
                        _append_cross_progress(
                            hrun,
                            "heartbeat",
                            "联审任务仍在执行中，正在持续分析代码与调用链",
                            "info",
                        )
                        await hdb.commit()
            except asyncio.CancelledError:
                return

        heartbeat_task = asyncio.create_task(_cross_heartbeat())
        review_trace_log.write_review_event(
            "cross",
            run_id,
            "execute_start",
            {
                "branch_name": branch_name,
                "repo_count": len(repos),
                "repos": [str(r.get("repo_name") or "") for r in repos],
            },
        )

        stream_buffer = ""
        stream_last_flush = time.monotonic()

        async def _flush_cross_stream(force: bool = False):
            nonlocal stream_buffer, stream_last_flush
            now = time.monotonic()
            if not force and len(stream_buffer) < 240 and (now - stream_last_flush) < 1.0:
                return
            text = _sanitize_stream_chunk(stream_buffer)
            stream_buffer = ""
            stream_last_flush = now
            if not text:
                return
            async with async_session() as sdb:
                rres = await sdb.execute(select(CrossRepoReviewRun).where(CrossRepoReviewRun.id == run_id))
                run_obj = rres.scalar_one_or_none()
                if run_obj and run_obj.status == "reviewing":
                    _append_cross_progress(run_obj, "llm_stream_chunk", text)
                    await sdb.commit()

        async def _on_cross_stream(chunk: str):
            nonlocal stream_buffer
            stream_buffer += chunk
            if len(stream_buffer) > 4000:
                stream_buffer = stream_buffer[-4000:]
            await _flush_cross_stream(force=False)

        unified = await review_service.run_cross_repo_review(
            branch_name=branch_name,
            repos=repos,
            child_hints=None,
            extra_instructions=profile_instruction,
            on_stream=_on_cross_stream,
        )
        review_trace_log.write_review_event(
            "cross",
            run_id,
            "llm_result_received",
            {
                "passed": bool(unified.get("passed")),
                "summary": str(unified.get("summary") or "")[:300],
                "findings_count": int(unified.get("findings_count") or 0),
            },
        )
        await _flush_cross_stream(force=True)

        async with async_session() as db:
            run_res = await db.execute(select(CrossRepoReviewRun).where(CrossRepoReviewRun.id == run_id))
            run = run_res.scalar_one_or_none()
            if not run:
                return
            child_reviews = unified.get("child_reviews") or []
            if isinstance(child_reviews, list):
                fail_count = 0
                issue_total = 0
                repo_id_by_name = {
                    str(x.get("repo_name") or "").strip().lower(): int(x.get("repo_id") or 0)
                    for x in repos
                }
                for item in child_reviews[:80]:
                    repo_name = str(item.get("repo_name") or "-")
                    repo_status = str(item.get("status") or "-")
                    findings = int(item.get("findings_count") or 0)
                    issue_total += findings
                    if repo_status != "passed":
                        fail_count += 1
                    _append_cross_progress(
                        run,
                        "sub_review_completed",
                        f"分仓审查完成：{repo_name}，状态={repo_status}，问题数={findings}",
                        "success" if repo_status == "passed" else "warning",
                    )
                    repo_id = int(item.get("repo_id") or 0)
                    if repo_id <= 0:
                        repo_id = repo_id_by_name.get(repo_name.strip().lower(), 0)
                    if repo_id > 0:
                        branch = str(item.get("branch_name") or branch_name)
                        target_commit = str(item.get("target_commit") or "").strip() or "unknown"
                        baseline_branch = str(item.get("baseline_branch") or "master")
                        existing_child_res = await db.execute(
                            select(ReviewResult).where(
                                ReviewResult.cross_run_id == run_id,
                                ReviewResult.repo_id == repo_id,
                                ReviewResult.branch_name == branch,
                            )
                        )
                        child_record = existing_child_res.scalar_one_or_none()
                        if not child_record:
                            child_record = ReviewResult(
                                repo_id=repo_id,
                                profile_id=None,
                                cross_run_id=run_id,
                                commit_hash=target_commit[:40],
                                baseline_branch=baseline_branch,
                                branch_name=branch,
                                status="reviewing",
                                started_at=now_cn(),
                                summary="联审分仓任务创建成功，等待结果",
                                review_progress=json.dumps(
                                    [_build_progress_event("queued", "联审子仓任务已创建")],
                                    ensure_ascii=False,
                                ),
                            )
                            db.add(child_record)
                        child_record.status = "passed" if repo_status == "passed" else "failed"
                        child_record.commit_hash = target_commit[:40]
                        child_record.baseline_branch = baseline_branch
                        child_record.summary = str(item.get("summary") or "")
                        child_record.detail = str(item.get("detail") or "")
                        child_record.findings_count = findings
                        child_record.completed_at = now_cn()
                        _append_progress(
                            child_record,
                            "completed",
                            f"联审分仓审查完成：状态={child_record.status}，问题数={child_record.findings_count}",
                            "success" if child_record.status == "passed" else "warning",
                        )
                        review_trace_log.write_review_event(
                            "cross",
                            run_id,
                            "sub_review_persisted",
                            {
                                "repo_id": repo_id,
                                "repo_name": repo_name,
                                "status": child_record.status,
                                "findings_count": child_record.findings_count,
                            },
                        )
                _append_cross_progress(
                    run,
                    "aggregate_summary",
                    f"分仓阶段汇总：仓库={len(child_reviews)}，未通过={fail_count}，问题总数={issue_total}",
                    "warning" if fail_count > 0 else "info",
                )

            if unified.get("detail"):
                run.status = "passed" if unified.get("passed") else "failed"
                run.summary = str(unified.get("summary") or "")
                run.detail = str(unified.get("detail") or "")
            else:
                run.status = "error"
                run.summary = "跨仓库联审失败：未生成有效报告"
                run.detail = "未生成有效报告"

            thought = str(unified.get("ai_thought_summary") or "").strip()
            if thought:
                _append_cross_progress(run, "ai_thought_summary", thought)
            loaded_keys = [str(k) for k in (unified.get("loaded_guidance_keys") or []) if str(k)]
            if loaded_keys:
                _append_cross_progress(
                    run,
                    "context_loaded",
                    f"汇总阶段已加载知识键：{', '.join(loaded_keys)}",
                )
            for idx, req in enumerate((unified.get("context_request_rounds") or [])[:8], 1):
                req_keys = [str(k) for k in (req or []) if str(k)]
                if req_keys:
                    _append_cross_progress(
                        run,
                        "context_request",
                        f"汇总阶段第{idx}轮请求上下文：{', '.join(req_keys)}",
                    )
            for step in (unified.get("ai_thought_steps") or [])[:12]:
                msg = str(step).strip()
                if msg:
                    _append_cross_progress(run, "ai_thought_step", msg)
            for call in (unified.get("tool_calls") or [])[:12]:
                name = str(call.get("name", "")).strip() or "tool"
                args = str(call.get("args", "")).strip()
                _append_cross_progress(
                    run,
                    "tool_call",
                    f"{name}{(' · ' + args) if args else ''}",
                )

            run.completed_at = now_cn()
            _append_cross_progress(
                run,
                "completed",
                run.summary,
                "success" if run.status == "passed" else "warning",
            )
            await db.commit()
        review_trace_log.write_review_event(
            "cross",
            run_id,
            "execute_completed",
            {"status": run.status, "summary": (run.summary or "")[:300]},
        )
    except Exception as e:
        logger.error("Cross review crashed: run_id=%s err=%s", run_id, e, exc_info=True)
        review_trace_log.write_review_event(
            "cross",
            run_id,
            "execute_error",
            {"error": str(e)},
        )
        async with async_session() as db:
            run_res = await db.execute(select(CrossRepoReviewRun).where(CrossRepoReviewRun.id == run_id))
            run = run_res.scalar_one_or_none()
            if run and not run.completed_at:
                run.status = "error"
                run.summary = f"跨仓库联审失败：{e}"
                run.completed_at = now_cn()
                _append_cross_progress(run, "error", run.summary, "error")
                await db.commit()
    finally:
        if heartbeat_task:
            heartbeat_task.cancel()


async def _cross_review_worker(worker_index: int):
    logger.info("Cross review worker-%d started", worker_index)
    while True:
        job = await _cross_review_queue.get()
        run_id = int(job["run_id"])
        try:
            await _mark_cross_job_started(run_id)
            await _execute_cross_run(
                run_id=run_id,
                branch_name=str(job["branch_name"]),
                repos=list(job["repos"]),
                profile_instruction=str(job.get("profile_instruction") or ""),
            )
        except Exception as e:
            logger.error("Cross review worker-%d crashed on run=%s err=%s", worker_index, run_id, e, exc_info=True)
        finally:
            await _mark_cross_job_finished(run_id)
            _cross_review_queue.task_done()


@router.get("/reviews/{review_id}/report")
async def download_report(review_id: int, db: AsyncSession = Depends(get_db)):
    """Download a review report as a Markdown file."""
    result = await db.execute(
        select(ReviewResult).where(ReviewResult.id == review_id)
    )
    review = result.scalar_one_or_none()
    if not review:
        raise HTTPException(404, "Review not found")

    if review.status == "reviewing":
        raise HTTPException(400, "Review is still in progress")

    report = _build_report_markdown(review)
    branch_safe = review.branch_name.replace("/", "_")
    filename = f"review_{review.id}_{branch_safe}_{review.commit_hash[:8]}.md"

    return Response(
        content=report,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/reviews/cross-repo/{run_id}/report")
async def download_cross_report(run_id: int, db: AsyncSession = Depends(get_db)):
    """Download cross-repo aggregate report as Markdown."""
    result = await db.execute(
        select(CrossRepoReviewRun).where(CrossRepoReviewRun.id == run_id)
    )
    run = result.scalar_one_or_none()
    if not run:
        raise HTTPException(404, "Cross review run not found")

    if run.status == "reviewing":
        raise HTTPException(400, "Cross review is still in progress")

    report = _build_cross_report_markdown(run)
    branch_safe = (run.branch_name or "cross").replace("/", "_")
    filename = f"cross_review_{run.id}_{branch_safe}.md"
    return Response(
        content=report,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _build_report_markdown(review: ReviewResult) -> str:
    """Build the downloadable markdown report.

    The detail field already contains the full markdown generated by the
    LLM.  We prepend a metadata header so the downloaded file is
    self-contained.
    """
    status_map = {"passed": "通过", "failed": "不通过", "error": "错误"}
    status_label = status_map.get(review.status, review.status)
    lines = [
        f"# 代码审查报告 #{review.id}",
        "",
        f"| 字段 | 值 |",
        f"|------|-----|",
        f"| 结果 | **{status_label}** |",
        f"| 分支 | `{review.branch_name}` |",
        f"| 基线分支 | `{review.baseline_branch}` |",
        f"| Commit | `{review.commit_hash}` |",
        f"| 问题数 | {review.findings_count} |",
        f"| 开始时间 | {review.started_at.strftime('%Y-%m-%d %H:%M:%S') if review.started_at else '-'} |",
        f"| 完成时间 | {review.completed_at.strftime('%Y-%m-%d %H:%M:%S') if review.completed_at else '-'} |",
        "",
        "---",
        "",
        review.detail or "暂无审查详情。",
        "",
    ]
    return "\n".join(lines)


def _build_cross_report_markdown(run: CrossRepoReviewRun) -> str:
    status_map = {"passed": "通过", "failed": "不通过", "error": "错误", "partial_failed": "部分失败"}
    status_label = status_map.get(run.status, run.status)
    lines = [
        f"# 跨仓库联审报告 #{run.id}",
        "",
        "| 字段 | 值 |",
        "|------|-----|",
        f"| 结果 | **{status_label}** |",
        f"| 目标分支 | `{run.branch_name}` |",
        f"| 开始时间 | {run.started_at.strftime('%Y-%m-%d %H:%M:%S') if run.started_at else '-'} |",
        f"| 完成时间 | {run.completed_at.strftime('%Y-%m-%d %H:%M:%S') if run.completed_at else '-'} |",
        "",
        "---",
        "",
        run.detail or "暂无联审详情。",
        "",
    ]
    return "\n".join(lines)


async def _create_review_records(
    repo: Repository,
    branch_name: str,
    profiles: list[ReviewProfile],
    db: AsyncSession,
    skip_if_no_diff: bool = False,
    force: bool = False,
    cross_run_id: int | None = None,
) -> list[ReviewResult]:
    """Create 'reviewing' status records for a branch. Returns the new records.
    If skip_if_no_diff is True, returns empty list when branch has no diff against baseline.
    If force is True, always creates new records even if the same commit+profile was reviewed before.
    """
    repo_path = Path(repo.local_path)
    remote_ref = f"origin/{branch_name}"

    try:
        full_hash = git_service.resolve_ref(repo_path, remote_ref)
    except git_service.GitError:
        try:
            full_hash = git_service.resolve_ref(repo_path, branch_name)
            remote_ref = branch_name
        except git_service.GitError:
            raise HTTPException(400, f"Cannot resolve branch: {branch_name}")

    if skip_if_no_diff:
        baseline_ref = f"origin/{repo.baseline_branch}"
        try:
            git_service.resolve_ref(repo_path, baseline_ref)
        except git_service.GitError:
            baseline_ref = repo.baseline_branch
        if git_service.is_ancestor(repo_path, remote_ref, baseline_ref):
            return []

    reviewed_profile_ids: set[int] = set()
    if not force:
        existing = await db.execute(
            select(ReviewResult).where(
                ReviewResult.repo_id == repo.id,
                ReviewResult.branch_name == branch_name,
                ReviewResult.commit_hash == full_hash,
            )
        )
        reviewed_profile_ids = {r.profile_id for r in existing.scalars().all()}

    records: list[ReviewResult] = []
    target_profiles = profiles
    if not target_profiles:
        target_profiles = [None]

    for profile in target_profiles:
        profile_id = profile.id if profile else None
        if profile_id in reviewed_profile_ids:
            continue
        record = ReviewResult(
            repo_id=repo.id,
            profile_id=profile_id,
            cross_run_id=cross_run_id,
            commit_hash=full_hash,
            baseline_branch=repo.baseline_branch,
            branch_name=branch_name,
            status="reviewing",
            started_at=now_cn(),
            summary="任务已入队，等待执行",
            review_progress=json.dumps(
                [_build_progress_event("queued", "审查任务已创建，等待进入执行队列")],
                ensure_ascii=False,
            ),
        )
        db.add(record)
        records.append(record)

    if records:
        await db.commit()
        for r in records:
            await db.refresh(r)
            review_trace_log.write_review_event(
                "single",
                r.id,
                "record_created",
                {
                    "repo_id": repo.id,
                    "branch_name": branch_name,
                    "baseline_branch": repo.baseline_branch,
                    "profile_id": r.profile_id,
                    "cross_run_id": cross_run_id,
                    "commit_hash": r.commit_hash,
                },
            )

    return records


async def _execute_review(
    review_id: int,
    local_path: str,
    baseline: str,
    target_ref: str,
    profile_id: int | None,
):
    """Run the actual review for a single record in the background."""
    logger.info("Background review starting: review_id=%s target=%s", review_id, target_ref)
    heartbeat_task: asyncio.Task | None = None
    try:
        async with async_session() as db:
            result = await db.execute(select(ReviewResult).where(ReviewResult.id == review_id))
            record = result.scalar_one_or_none()
            if not record or record.status != "reviewing":
                logger.warning("Review #%s skipped: not found or not in reviewing state", review_id)
                return
            review_trace_log.write_review_event(
                "single",
                review_id,
                "execute_start",
                {
                    "local_path": local_path,
                    "baseline": baseline,
                    "target_ref": target_ref,
                    "profile_id": profile_id,
                },
            )

            profile: ReviewProfile | None = None
            if profile_id is not None:
                prof_result = await db.execute(select(ReviewProfile).where(ReviewProfile.id == profile_id))
                profile = prof_result.scalar_one_or_none()
                if not profile:
                    record.status = "error"
                    record.summary = "审查失败：Profile 不存在或已删除"
                    _append_progress(record, "error", "Profile 不存在或已删除，任务终止", "error")
                    record.completed_at = now_cn()
                    await db.commit()
                    return

            repo_lock = _get_repo_lock(local_path)
            if repo_lock.locked():
                _append_progress(record, "waiting_repo_lock", "等待仓库执行锁，避免并发 checkout 冲突")
                await db.commit()

            async with repo_lock:
                _append_progress(record, "start", "已进入执行队列，开始准备审查上下文")
                record.summary = "审查进行中：正在准备代码上下文"
                await db.commit()

                async def _single_heartbeat():
                    try:
                        while True:
                            await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
                            async with async_session() as hdb:
                                hres = await hdb.execute(
                                    select(ReviewResult).where(ReviewResult.id == review_id)
                                )
                                hrecord = hres.scalar_one_or_none()
                                if not hrecord or hrecord.status != "reviewing":
                                    return
                                _append_progress(
                                    hrecord,
                                    "heartbeat",
                                    "审查任务仍在执行中，正在持续分析代码上下文",
                                    "info",
                                )
                                await hdb.commit()
                    except asyncio.CancelledError:
                        return

                heartbeat_task = asyncio.create_task(_single_heartbeat())

                try:
                    file_pats = json.loads(profile.file_patterns) if profile and profile.file_patterns else []
                    excl_pats = json.loads(profile.exclude_patterns) if profile and profile.exclude_patterns else []
                    _append_progress(
                        record,
                        "llm_review",
                        f"开始调用模型审查（目标: {target_ref}，文件过滤规则: include={len(file_pats)} exclude={len(excl_pats)}）",
                    )
                    record.summary = "审查进行中：模型正在分析代码"
                    await db.commit()

                    stream_buffer = ""
                    stream_last_flush = time.monotonic()

                    async def _flush_stream(force: bool = False) -> None:
                        nonlocal stream_buffer, stream_last_flush
                        now = time.monotonic()
                        if not force and len(stream_buffer) < 240 and (now - stream_last_flush) < 1.0:
                            return
                        text = _sanitize_stream_chunk(stream_buffer)
                        stream_buffer = ""
                        stream_last_flush = now
                        if not text:
                            return
                        _append_progress(record, "llm_stream_chunk", text)
                        await db.commit()

                    async def _on_stream(chunk: str):
                        nonlocal stream_buffer
                        stream_buffer += chunk
                        if len(stream_buffer) > 4000:
                            stream_buffer = stream_buffer[-4000:]
                        await _flush_stream(force=False)

                    result_data = await review_service.run_review(
                        local_path=local_path,
                        baseline_branch=baseline,
                        target_ref=target_ref,
                        prompt_template=profile.prompt_template if profile else "",
                        file_patterns=file_pats or None,
                        exclude_patterns=excl_pats or None,
                        on_stream=_on_stream,
                    )
                    await _flush_stream(force=True)

                    ai_thought = str(result_data.get("ai_thought_summary", "")).strip()
                    if ai_thought:
                        _append_progress(record, "ai_thought_summary", ai_thought)
                    loaded_keys = [str(k) for k in (result_data.get("loaded_guidance_keys") or []) if str(k)]
                    if loaded_keys:
                        _append_progress(
                            record,
                            "context_loaded",
                            f"已加载审查知识键：{', '.join(loaded_keys)}",
                        )
                    for idx, req in enumerate((result_data.get("context_request_rounds") or [])[:8], 1):
                        req_keys = [str(k) for k in (req or []) if str(k)]
                        if req_keys:
                            _append_progress(
                                record,
                                "context_request",
                                f"第{idx}轮请求上下文：{', '.join(req_keys)}",
                            )
                    for step in (result_data.get("ai_thought_steps") or [])[:12]:
                        msg = str(step).strip()
                        if msg:
                            _append_progress(record, "ai_thought_step", msg)
                    for call in (result_data.get("tool_calls") or [])[:12]:
                        name = str(call.get("name", "")).strip() or "tool"
                        args = str(call.get("args", "")).strip()
                        _append_progress(
                            record,
                            "tool_call",
                            f"{name}{(' · ' + args) if args else ''}",
                        )

                    record.status = "passed" if result_data["passed"] else "failed"
                    target_commit = str(result_data.get("target_commit") or "").strip()
                    if target_commit:
                        record.commit_hash = target_commit
                    record.summary = result_data["summary"]
                    record.detail = result_data["detail"]
                    record.findings_count = result_data["findings_count"]
                    record.completed_at = now_cn()
                    _append_progress(
                        record,
                        "completed",
                        f"审查完成：状态={record.status}，发现问题={record.findings_count}",
                        "success" if record.status == "passed" else "warning",
                    )
                    review_trace_log.write_review_event(
                        "single",
                        review_id,
                        "execute_completed",
                        {
                            "status": record.status,
                            "summary": str(record.summary or "")[:300],
                            "findings_count": int(record.findings_count or 0),
                            "loaded_guidance_keys": loaded_keys,
                            "context_request_rounds": result_data.get("context_request_rounds") or [],
                        },
                    )

                except Exception as e:
                    logger.error("Review failed for review_id=%s: %s", review_id, e, exc_info=True)
                    record.status = "error"
                    record.summary = f"审查执行失败：{e}"
                    _append_progress(record, "error", f"审查执行失败：{e}", "error")
                    record.completed_at = now_cn()
                    review_trace_log.write_review_event(
                        "single",
                        review_id,
                        "execute_error",
                        {"error": str(e)},
                    )

            await db.commit()
            logger.info("Review #%s completed: %s", review_id, record.status)
    except Exception as e:
        logger.error("Background review task crashed for review_id=%s: %s", review_id, e, exc_info=True)
    finally:
        if heartbeat_task:
            heartbeat_task.cancel()


async def _review_worker(worker_index: int):
    logger.info("Review worker-%d started", worker_index)
    while True:
        job = await _review_queue.get()
        try:
            await _mark_job_started(job["review_id"])
            await _execute_review(
                review_id=job["review_id"],
                local_path=job["local_path"],
                baseline=job["baseline"],
                target_ref=job["target_ref"],
                profile_id=job["profile_id"],
            )
        except Exception as e:
            logger.error("Review worker-%d crashed on job=%s err=%s", worker_index, job, e, exc_info=True)
        finally:
            await _mark_job_finished(job["review_id"])
            _review_queue.task_done()


@router.post("/repos/{repo_id}/reviews", response_model=TriggerReviewResponse, status_code=201)
async def trigger_review(repo_id: int, body: ReviewTrigger, db: AsyncSession = Depends(get_db)):
    """Manually trigger a review. Returns 'reviewing' records immediately, runs reviews in background."""
    result = await db.execute(
        select(Repository)
        .where(Repository.id == repo_id)
        .options(selectinload(Repository.profiles))
    )
    repo = result.scalar_one_or_none()
    if not repo:
        raise HTTPException(404, "Repository not found")

    if not git_service.validate_repo(repo.local_path):
        raise HTTPException(400, f"Invalid git repo: {repo.local_path}")

    repo_path = Path(repo.local_path)

    from app.services import sync_service
    try:
        await sync_service.sync_repo_branches(repo_id, db)
    except git_service.GitError as e:
        raise HTTPException(500, f"Git fetch failed: {e}")
    except ValueError as e:
        raise HTTPException(400, str(e))

    selected_profile_ids = sorted(
        {*(body.profile_ids or []), *([body.profile_id] if body.profile_id else [])}
    )
    if selected_profile_ids:
        profiles = [
            p for p in repo.profiles
            if p.enabled and p.id in selected_profile_ids
        ]
        if not profiles:
            raise HTTPException(400, "所选 Profile 无效或未启用")
    else:
        # 默认不使用任何 Profile（即不额外带入模板和过滤规则）
        profiles = []

    all_records: list[ReviewResult] = []
    skipped_stale: list[str] = []
    cutoff = _stale_cutoff()

    if body.branch_name:
        records = await _create_review_records(repo, body.branch_name, profiles, db, force=True)
        all_records.extend(records)
    else:
        remote_branches = git_service.list_remote_branches(repo_path)
        for rb in remote_branches:
            if rb["name"] == repo.baseline_branch or not rb["last_commit_hash"]:
                continue
            if rb.get("last_commit_date") and rb["last_commit_date"] < cutoff:
                skipped_stale.append(rb["name"])
                continue
            records = await _create_review_records(repo, rb["name"], profiles, db, skip_if_no_diff=True)
            all_records.extend(records)

    if not all_records:
        msg = "所有分支均无需审查。"
        if skipped_stale:
            msg += f"其中 {len(skipped_stale)} 个分支因最后更新超过 {STALE_BRANCH_DAYS} 天被跳过，可使用「审查指定分支」手动触发。"
        raise HTTPException(400, msg)

    await _ensure_review_workers()

    # Enqueue review jobs; actual execution is controlled by worker queue + per-repo lock
    for record in all_records:
        await _enqueue_review_job(
            review_id=record.id,
            local_path=repo.local_path,
            baseline=repo.baseline_branch,
            target_ref=f"origin/{record.branch_name}",
            profile_id=record.profile_id,
        )

    return TriggerReviewResponse(
        records=all_records,
        skipped_stale_count=len(skipped_stale),
        skipped_stale_branches=skipped_stale,
    )
