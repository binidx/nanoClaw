"""
Scheduler service — manages periodic polling jobs using APScheduler.
Each enabled polling config gets an interval job that fetches new commits and triggers reviews.
"""

import json
import logging
import asyncio
from datetime import datetime, timedelta
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.database import async_session
from app.models import TZ_CN, CrossRepoReviewRun, PollingConfig, Repository, ReviewResult, now_cn
from app.services import git_service
from app.services import notification_service
from app.services import review_service
from app.services import review_trace_log

logger = logging.getLogger("code-review.scheduler")
WATCHDOG_INTERVAL_MINUTES = 1
WATCHDOG_STALE_MINUTES = 3
HEARTBEAT_INTERVAL_SECONDS = 60


def _build_progress_event(stage: str, message: str, level: str = "info") -> dict:
    return {
        "time": now_cn().isoformat(timespec="seconds"),
        "stage": stage,
        "message": message,
        "level": level,
    }


def _append_progress(record: ReviewResult, stage: str, message: str, level: str = "info") -> None:
    events = []
    if record.review_progress:
        try:
            parsed = json.loads(record.review_progress)
            if isinstance(parsed, list):
                events = parsed
        except Exception:
            events = []
    events.append(_build_progress_event(stage=stage, message=message, level=level))
    if len(events) > 120:
        events = events[-120:]
    record.review_progress = json.dumps(events, ensure_ascii=False)


def _append_cross_progress(run: CrossRepoReviewRun, stage: str, message: str, level: str = "info") -> None:
    events = []
    if run.review_progress:
        try:
            parsed = json.loads(run.review_progress)
            if isinstance(parsed, list):
                events = parsed
        except Exception:
            events = []
    events.append(_build_progress_event(stage=stage, message=message, level=level))
    if len(events) > 200:
        events = events[-200:]
    run.review_progress = json.dumps(events, ensure_ascii=False)


class SchedulerService:
    def __init__(self):
        self.scheduler = AsyncIOScheduler()
        self._running = False

    async def start(self):
        if self._running:
            return
        self.scheduler.start()
        self._running = True
        await self._load_all_jobs()
        self._add_watchdog_job()

    async def stop(self):
        if self._running:
            self.scheduler.shutdown(wait=False)
            self._running = False

    async def _load_all_jobs(self):
        async with async_session() as db:
            result = await db.execute(
                select(PollingConfig).where(PollingConfig.enabled == True)  # noqa: E712
            )
            configs = result.scalars().all()
            for config in configs:
                self._add_job(config)
                logger.info("Loaded polling job for repo_id=%s interval=%dm", config.repo_id, config.interval_minutes)

    def _job_id(self, repo_id: int) -> str:
        return f"poll_repo_{repo_id}"

    def _add_job(self, config: PollingConfig):
        job_id = self._job_id(config.repo_id)
        existing = self.scheduler.get_job(job_id)
        if existing:
            self.scheduler.remove_job(job_id)

        self.scheduler.add_job(
            self._poll_repo,
            "interval",
            minutes=config.interval_minutes,
            id=job_id,
            args=[config.repo_id],
            replace_existing=True,
            max_instances=1,
        )

    def _add_watchdog_job(self):
        job_id = "review_runtime_watchdog"
        existing = self.scheduler.get_job(job_id)
        if existing:
            self.scheduler.remove_job(job_id)
        self.scheduler.add_job(
            self._watchdog_review_runtime,
            "interval",
            minutes=WATCHDOG_INTERVAL_MINUTES,
            id=job_id,
            replace_existing=True,
            max_instances=1,
        )
        logger.info(
            "Loaded watchdog job interval=%dm stale=%dm",
            WATCHDOG_INTERVAL_MINUTES,
            WATCHDOG_STALE_MINUTES,
        )

    async def _watchdog_review_runtime(self):
        """Fail reviewing records that are not actually in queue/executing runtime sets."""
        cutoff = now_cn() - timedelta(minutes=WATCHDOG_STALE_MINUTES)
        from app.api import reviews as reviews_api

        runtime = await reviews_api.get_runtime_queue_snapshot()
        single_active = runtime["single_active"]
        single_queued = runtime["single_queued"]
        cross_active = runtime["cross_active"]
        cross_queued = runtime["cross_queued"]

        async with async_session() as db:
            # single-repo review watchdog
            res = await db.execute(
                select(ReviewResult).where(
                    ReviewResult.status == "reviewing",
                    ReviewResult.started_at.is_not(None),
                    ReviewResult.started_at < cutoff,
                )
            )
            stale_single = res.scalars().all()
            single_failed = 0
            for record in stale_single:
                rid = int(record.id)
                if rid in single_active or rid in single_queued:
                    continue
                record.status = "failed"
                record.summary = "审查失败：巡检发现任务未在实际执行（已自动终止）"
                record.completed_at = now_cn()
                _append_progress(record, "watchdog_fail", record.summary, "error")
                review_trace_log.write_review_event(
                    "single",
                    rid,
                    "watchdog_fail",
                    {
                        "reason": "reviewing status but not in runtime queue/active sets",
                        "cutoff_minutes": WATCHDOG_STALE_MINUTES,
                    },
                )
                single_failed += 1

            # cross-repo review watchdog
            cres = await db.execute(
                select(CrossRepoReviewRun).where(
                    CrossRepoReviewRun.status == "reviewing",
                    CrossRepoReviewRun.started_at.is_not(None),
                    CrossRepoReviewRun.started_at < cutoff,
                )
            )
            stale_cross = cres.scalars().all()
            cross_failed = 0
            for run in stale_cross:
                run_id = int(run.id)
                if run_id in cross_active or run_id in cross_queued:
                    continue
                run.status = "failed"
                run.summary = "联审失败：巡检发现任务未在实际执行（已自动终止）"
                run.completed_at = now_cn()
                _append_cross_progress(run, "watchdog_fail", run.summary, "error")
                review_trace_log.write_review_event(
                    "cross",
                    run_id,
                    "watchdog_fail",
                    {
                        "reason": "reviewing status but not in runtime queue/active sets",
                        "cutoff_minutes": WATCHDOG_STALE_MINUTES,
                    },
                )
                cross_failed += 1

            if single_failed or cross_failed:
                await db.commit()
                logger.warning(
                    "Watchdog auto-failed stale reviews: single=%d cross=%d",
                    single_failed,
                    cross_failed,
                )

    async def sync_job(self, config: PollingConfig):
        """Add, update, or remove a job based on current config."""
        job_id = self._job_id(config.repo_id)
        if config.enabled:
            self._add_job(config)
            logger.info("Synced polling job repo_id=%s interval=%dm", config.repo_id, config.interval_minutes)
        else:
            existing = self.scheduler.get_job(job_id)
            if existing:
                self.scheduler.remove_job(job_id)
                logger.info("Removed polling job repo_id=%s", config.repo_id)

    async def _poll_repo(self, repo_id: int):
        """Poll a repository: fetch all branches, compare each against baseline, run reviews."""
        logger.info("Polling repo_id=%s", repo_id)

        async with async_session() as db:
            result = await db.execute(
                select(Repository)
                .where(Repository.id == repo_id)
                .options(
                    selectinload(Repository.profiles),
                    selectinload(Repository.notifications),
                    selectinload(Repository.polling_config),
                    selectinload(Repository.branches),
                )
            )
            repo = result.scalar_one_or_none()
            if not repo or not repo.enabled:
                logger.warning("Repo %s not found or disabled, skipping poll", repo_id)
                return

            polling = repo.polling_config
            if not polling or not polling.enabled:
                return

            repo_path = Path(repo.local_path)
            if not git_service.validate_repo(repo.local_path):
                polling.last_poll_status = "failure"
                polling.last_poll_message = "Invalid git repository path"
                polling.last_poll_at = now_cn()
                await db.commit()
                return

            # Step 1+2: Fetch remote and sync branch list (same as clicking "同步")
            from app.services import sync_service
            try:
                await sync_service.sync_repo_branches(repo_id, db)
            except (git_service.GitError, ValueError) as e:
                polling.last_poll_status = "failure"
                polling.last_poll_message = f"Sync failed: {e}"
                polling.last_poll_at = now_cn()
                await db.commit()
                return

            remote_branches = git_service.list_remote_branches(repo_path)

            # Step 3: Check enabled profiles
            enabled_profiles = [p for p in repo.profiles if p.enabled]
            if not enabled_profiles:
                polling.last_poll_status = "success"
                polling.last_poll_message = "No enabled profiles"
                polling.last_poll_at = now_cn()
                await db.commit()
                return

            # Step 4: Collect all branches needing review, insert "reviewing" records first
            baseline = repo.baseline_branch
            baseline_ref = f"origin/{baseline}"
            try:
                git_service.resolve_ref(repo_path, baseline_ref)
            except git_service.GitError:
                baseline_ref = baseline

            pending_reviews: list[tuple[ReviewResult, "ReviewProfile"]] = []
            skipped_no_diff = 0
            skipped_stale = 0
            cutoff = datetime.now(TZ_CN) - timedelta(days=5)

            for rb in remote_branches:
                branch_name = rb["name"]
                if branch_name == baseline or not rb["last_commit_hash"]:
                    continue

                if rb.get("last_commit_date") and rb["last_commit_date"] < cutoff:
                    skipped_stale += 1
                    continue

                remote_ref = f"origin/{branch_name}"
                try:
                    full_hash = git_service.resolve_ref(repo_path, remote_ref)
                except git_service.GitError:
                    continue

                # Skip branches already fully contained in baseline
                if git_service.is_ancestor(repo_path, remote_ref, baseline_ref):
                    skipped_no_diff += 1
                    continue

                existing_review = await db.execute(
                    select(ReviewResult).where(
                        ReviewResult.repo_id == repo_id,
                        ReviewResult.branch_name == branch_name,
                        ReviewResult.commit_hash == full_hash,
                    )
                )
                reviewed_profile_ids = {r.profile_id for r in existing_review.scalars().all()}

                for profile in enabled_profiles:
                    if profile.id in reviewed_profile_ids:
                        continue
                    record = ReviewResult(
                        repo_id=repo_id,
                        profile_id=profile.id,
                        commit_hash=full_hash,
                        baseline_branch=baseline,
                        branch_name=branch_name,
                        status="reviewing",
                        started_at=now_cn(),
                        summary="任务已入队，等待执行",
                        review_progress=json.dumps(
                            [_build_progress_event("queued", "轮询创建审查任务，等待执行")],
                            ensure_ascii=False,
                        ),
                    )
                    db.add(record)
                    pending_reviews.append((record, profile))

            if skipped_no_diff:
                logger.info("Skipped %d branches already merged into baseline for repo_id=%s", skipped_no_diff, repo_id)
            if skipped_stale:
                logger.info("Skipped %d stale branches (>5 days) for repo_id=%s", skipped_stale, repo_id)

            if pending_reviews:
                await db.commit()
                for rec, _ in pending_reviews:
                    await db.refresh(rec)
                logger.info("Created %d reviewing records for repo_id=%s", len(pending_reviews), repo_id)

            # Step 5: Execute reviews sequentially
            all_passed = True
            for review_record, profile in pending_reviews:
                heartbeat_task: asyncio.Task | None = None
                try:
                    file_pats = json.loads(profile.file_patterns) if profile.file_patterns else None
                    excl_pats = json.loads(profile.exclude_patterns) if profile.exclude_patterns else None
                    _append_progress(review_record, "start", "开始执行轮询审查任务")
                    _append_progress(review_record, "llm_review", "模型正在分析代码变更")
                    review_record.summary = "审查进行中：模型正在分析代码"
                    await db.commit()

                    async def _polling_heartbeat():
                        try:
                            while True:
                                await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
                                async with async_session() as hdb:
                                    hres = await hdb.execute(
                                        select(ReviewResult).where(ReviewResult.id == review_record.id)
                                    )
                                    hrecord = hres.scalar_one_or_none()
                                    if not hrecord or hrecord.status != "reviewing":
                                        return
                                    _append_progress(
                                        hrecord,
                                        "heartbeat",
                                        "轮询审查仍在执行中，正在持续分析代码上下文",
                                        "info",
                                    )
                                    await hdb.commit()
                        except asyncio.CancelledError:
                            return

                    heartbeat_task = asyncio.create_task(_polling_heartbeat())

                    result_data = await review_service.run_review(
                        local_path=repo.local_path,
                        baseline_branch=baseline,
                        target_ref=f"origin/{review_record.branch_name}",
                        prompt_template=profile.prompt_template,
                        file_patterns=file_pats if file_pats else None,
                        exclude_patterns=excl_pats if excl_pats else None,
                    )

                    ai_thought = str(result_data.get("ai_thought_summary", "")).strip()
                    if ai_thought:
                        _append_progress(review_record, "ai_thought_summary", ai_thought)
                    loaded_keys = [str(k) for k in (result_data.get("loaded_guidance_keys") or []) if str(k)]
                    if loaded_keys:
                        _append_progress(
                            review_record,
                            "context_loaded",
                            f"已加载审查知识键：{', '.join(loaded_keys)}",
                        )
                    for idx, req in enumerate((result_data.get("context_request_rounds") or [])[:8], 1):
                        req_keys = [str(k) for k in (req or []) if str(k)]
                        if req_keys:
                            _append_progress(
                                review_record,
                                "context_request",
                                f"第{idx}轮请求上下文：{', '.join(req_keys)}",
                            )
                    for step in (result_data.get("ai_thought_steps") or [])[:12]:
                        msg = str(step).strip()
                        if msg:
                            _append_progress(review_record, "ai_thought_step", msg)
                    for call in (result_data.get("tool_calls") or [])[:12]:
                        name = str(call.get("name", "")).strip() or "tool"
                        args = str(call.get("args", "")).strip()
                        _append_progress(
                            review_record,
                            "tool_call",
                            f"{name}{(' · ' + args) if args else ''}",
                        )

                    review_record.status = "passed" if result_data["passed"] else "failed"
                    target_commit = str(result_data.get("target_commit") or "").strip()
                    if target_commit:
                        review_record.commit_hash = target_commit
                    review_record.summary = result_data["summary"]
                    review_record.detail = result_data["detail"]
                    review_record.findings_count = result_data["findings_count"]
                    review_record.completed_at = now_cn()
                    _append_progress(
                        review_record,
                        "completed",
                        f"审查完成：状态={review_record.status}，发现问题={review_record.findings_count}",
                        "success" if review_record.status == "passed" else "warning",
                    )

                    if not result_data["passed"]:
                        all_passed = False

                except Exception as e:
                    logger.error("Review failed for repo=%s review_id=%s: %s", repo_id, review_record.id, e)
                    review_record.status = "error"
                    review_record.summary = f"审查执行失败：{e}"
                    _append_progress(review_record, "error", f"审查执行失败：{e}", "error")
                    review_record.completed_at = now_cn()
                    all_passed = False

                await db.commit()
                if heartbeat_task:
                    heartbeat_task.cancel()

            # Step 6: Send notifications if any reviews were done
            reviewed_count = len(pending_reviews)
            if reviewed_count > 0:
                enabled_notifs = [n for n in repo.notifications if n.enabled]
                if enabled_notifs:
                    summary = f"轮询审查完成: {reviewed_count} 条记录, {'全部通过' if all_passed else '存在问题'}"
                    await notification_service.send_notifications(
                        enabled_notifs, repo.name, summary, all_passed
                    )

            polling.last_poll_status = "success"
            polling.last_poll_message = f"Reviewed {reviewed_count} branch(es)" if reviewed_count > 0 else "No new commits on non-baseline branches"
            polling.last_poll_at = now_cn()
            await db.commit()
            logger.info("Poll complete for repo_id=%s reviewed=%d passed=%s", repo_id, reviewed_count, all_passed)


scheduler_service = SchedulerService()
