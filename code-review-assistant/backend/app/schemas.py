from datetime import datetime

from pydantic import BaseModel


# ---- Repository ----

class RepoCreate(BaseModel):
    name: str
    language: str = ""
    local_path: str
    source_type: str = "gitlab"
    baseline_branch: str = "master"
    enabled: bool = True


class RepoUpdate(BaseModel):
    name: str | None = None
    language: str | None = None
    local_path: str | None = None
    source_type: str | None = None
    baseline_branch: str | None = None
    enabled: bool | None = None


class NotificationOut(BaseModel):
    id: int
    repo_id: int
    type: str
    target: str
    target_name: str
    enabled: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class ProfileOut(BaseModel):
    id: int
    repo_id: int
    name: str
    description: str
    prompt_template: str
    file_patterns: str
    exclude_patterns: str
    severity_threshold: str
    enabled: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PollingOut(BaseModel):
    id: int
    repo_id: int
    interval_minutes: int
    enabled: bool
    last_poll_at: datetime | None
    last_poll_status: str | None
    last_poll_message: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class BranchOut(BaseModel):
    id: int
    repo_id: int
    name: str
    last_commit_hash: str
    last_commit_message: str
    last_commit_author: str
    last_commit_date: datetime | None
    synced_at: datetime

    model_config = {"from_attributes": True}


class ReviewResultOut(BaseModel):
    id: int
    repo_id: int
    profile_id: int | None
    cross_run_id: int | None = None
    commit_hash: str
    baseline_branch: str
    branch_name: str
    status: str
    summary: str
    detail: str
    review_progress: str = "[]"
    findings_count: int
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class RepoOut(BaseModel):
    id: int
    name: str
    language: str
    local_path: str
    source_type: str
    baseline_branch: str
    enabled: bool
    created_at: datetime
    updated_at: datetime
    notifications: list[NotificationOut] = []
    profiles: list[ProfileOut] = []
    polling_config: PollingOut | None = None
    branch_count: int = 0
    last_review: ReviewResultOut | None = None

    model_config = {"from_attributes": True}


class RepoListItem(BaseModel):
    id: int
    name: str
    language: str
    local_path: str
    source_type: str
    baseline_branch: str
    enabled: bool
    profile_count: int = 0
    notification_count: int = 0
    polling_enabled: bool = False
    polling_interval: int | None = None
    last_poll_at: datetime | None = None
    last_poll_status: str | None = None

    model_config = {"from_attributes": True}


# ---- Notification ----

class NotificationCreate(BaseModel):
    type: str
    target: str
    target_name: str = ""
    enabled: bool = True


class NotificationUpdate(BaseModel):
    type: str | None = None
    target: str | None = None
    target_name: str | None = None
    enabled: bool | None = None


# ---- Review Profile ----

class ProfileCreate(BaseModel):
    name: str
    description: str = ""
    prompt_template: str = ""
    file_patterns: str = "[]"
    exclude_patterns: str = "[]"
    severity_threshold: str = "P2"
    enabled: bool = True


class ProfileUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    prompt_template: str | None = None
    file_patterns: str | None = None
    exclude_patterns: str | None = None
    severity_threshold: str | None = None
    enabled: bool | None = None


# ---- Polling ----

class PollingUpdate(BaseModel):
    interval_minutes: int | None = None
    enabled: bool | None = None


# ---- Review ----

class ReviewTrigger(BaseModel):
    branch_name: str = ""
    profile_id: int | None = None
    profile_ids: list[int] = []


class PaginatedReviews(BaseModel):
    items: list[ReviewResultOut]
    total: int
    page: int
    page_size: int


class TriggerReviewResponse(BaseModel):
    records: list[ReviewResultOut]
    skipped_stale_count: int = 0
    skipped_stale_branches: list[str] = []


class ReviewQueueStatusOut(BaseModel):
    review_id: int
    status: str
    in_queue: bool
    executing: bool
    queue_position: int
    queued_total: int
    active_total: int
    max_concurrency: int


class CrossRepoReviewTrigger(BaseModel):
    branch_name: str
    profile_id: int | None = None
    profile_ids: list[int] = []


class CrossRepoProfileOptionOut(BaseModel):
    id: int
    repo_id: int
    repo_name: str
    name: str
    enabled: bool


class CrossRepoReviewRunOut(BaseModel):
    id: int
    branch_name: str
    status: str
    summary: str
    detail: str
    review_progress: str = "[]"
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class CrossRepoReviewDetailOut(BaseModel):
    run: CrossRepoReviewRunOut
    children: list[ReviewResultOut]


class CrossRepoQueueStatusOut(BaseModel):
    run_id: int
    status: str
    queued_total: int
    active_total: int
    done_total: int
    total_children: int
    max_concurrency: int


class CrossRepoPaginatedOut(BaseModel):
    items: list[CrossRepoReviewRunOut]
    total: int
    page: int
    page_size: int
