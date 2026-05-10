from datetime import datetime, timezone, timedelta

TZ_CN = timezone(timedelta(hours=8))


def now_cn() -> datetime:
    return datetime.now(TZ_CN).replace(tzinfo=None)


from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


class Repository(Base):
    __tablename__ = "repositories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    language = Column(String(50), default="")
    local_path = Column(String(500), nullable=False)
    source_type = Column(String(50), default="gitlab")
    baseline_branch = Column(String(200), default="master")
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=now_cn)
    updated_at = Column(DateTime, default=now_cn, onupdate=now_cn)

    notifications = relationship("NotificationConfig", back_populates="repository", cascade="all, delete-orphan")
    profiles = relationship("ReviewProfile", back_populates="repository", cascade="all, delete-orphan")
    polling_config = relationship("PollingConfig", back_populates="repository", uselist=False, cascade="all, delete-orphan")
    branches = relationship("Branch", back_populates="repository", cascade="all, delete-orphan")
    reviews = relationship("ReviewResult", back_populates="repository", cascade="all, delete-orphan")


class NotificationConfig(Base):
    __tablename__ = "notification_configs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    repo_id = Column(Integer, ForeignKey("repositories.id", ondelete="CASCADE"), nullable=False)
    type = Column(String(50), nullable=False)  # feishu, webhook
    target = Column(String(500), nullable=False)  # webhook url or group id
    target_name = Column(String(200), default="")
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=now_cn)

    repository = relationship("Repository", back_populates="notifications")


class ReviewProfile(Base):
    __tablename__ = "review_profiles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    repo_id = Column(Integer, ForeignKey("repositories.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(200), nullable=False)
    description = Column(Text, default="")
    prompt_template = Column(Text, default="")
    file_patterns = Column(Text, default="[]")  # JSON array
    exclude_patterns = Column(Text, default="[]")  # JSON array
    severity_threshold = Column(String(10), default="P2")
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=now_cn)
    updated_at = Column(DateTime, default=now_cn, onupdate=now_cn)

    repository = relationship("Repository", back_populates="profiles")
    reviews = relationship("ReviewResult", back_populates="profile")


class PollingConfig(Base):
    __tablename__ = "polling_configs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    repo_id = Column(Integer, ForeignKey("repositories.id", ondelete="CASCADE"), nullable=False, unique=True)
    interval_minutes = Column(Integer, default=30)
    enabled = Column(Boolean, default=True)
    last_poll_at = Column(DateTime, nullable=True)
    last_poll_status = Column(String(50), nullable=True)
    last_poll_message = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=now_cn)

    repository = relationship("Repository", back_populates="polling_config")


class Branch(Base):
    __tablename__ = "branches"
    __table_args__ = (UniqueConstraint("repo_id", "name", name="uq_branch_repo_name"),)

    id = Column(Integer, primary_key=True, autoincrement=True)
    repo_id = Column(Integer, ForeignKey("repositories.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(300), nullable=False)
    last_commit_hash = Column(String(40), default="")
    last_commit_message = Column(String(500), default="")
    last_commit_author = Column(String(200), default="")
    last_commit_date = Column(DateTime, nullable=True)
    synced_at = Column(DateTime, default=now_cn)

    repository = relationship("Repository", back_populates="branches")


class ReviewResult(Base):
    __tablename__ = "review_results"

    id = Column(Integer, primary_key=True, autoincrement=True)
    repo_id = Column(Integer, ForeignKey("repositories.id", ondelete="CASCADE"), nullable=False)
    profile_id = Column(Integer, ForeignKey("review_profiles.id", ondelete="SET NULL"), nullable=True)
    cross_run_id = Column(Integer, ForeignKey("cross_repo_review_runs.id", ondelete="SET NULL"), nullable=True)
    commit_hash = Column(String(40), nullable=False)
    baseline_branch = Column(String(200), nullable=False)
    branch_name = Column(String(200), default="")
    status = Column(String(20), default="pending")  # pending, reviewing, passed, failed, error
    summary = Column(Text, default="")
    detail = Column(Text, default="")
    review_progress = Column(Text, default="[]")  # JSON array of progress events
    findings_count = Column(Integer, default=0)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=now_cn)

    repository = relationship("Repository", back_populates="reviews")
    profile = relationship("ReviewProfile", back_populates="reviews")
    cross_run = relationship("CrossRepoReviewRun", back_populates="children")


class CrossRepoReviewRun(Base):
    __tablename__ = "cross_repo_review_runs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    branch_name = Column(String(200), nullable=False)
    status = Column(String(20), default="reviewing")  # reviewing, passed, failed, partial_failed, error
    summary = Column(Text, default="")
    detail = Column(Text, default="")
    review_progress = Column(Text, default="[]")  # JSON array of progress events
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=now_cn)

    children = relationship("ReviewResult", back_populates="cross_run")
