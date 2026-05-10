export interface RepoListItem {
  id: number;
  name: string;
  language: string;
  local_path: string;
  source_type: string;
  baseline_branch: string;
  enabled: boolean;
  profile_count: number;
  notification_count: number;
  polling_enabled: boolean;
  polling_interval: number | null;
  last_poll_at: string | null;
  last_poll_status: string | null;
}

export interface NotificationConfig {
  id: number;
  repo_id: number;
  type: string;
  target: string;
  target_name: string;
  enabled: boolean;
  created_at: string;
}

export interface ReviewProfile {
  id: number;
  repo_id: number;
  name: string;
  description: string;
  prompt_template: string;
  file_patterns: string;
  exclude_patterns: string;
  severity_threshold: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface PollingConfig {
  id: number;
  repo_id: number;
  interval_minutes: number;
  enabled: boolean;
  last_poll_at: string | null;
  last_poll_status: string | null;
  last_poll_message: string | null;
  created_at: string;
}

export interface BranchInfo {
  id: number;
  repo_id: number;
  name: string;
  last_commit_hash: string;
  last_commit_message: string;
  last_commit_author: string;
  last_commit_date: string | null;
  synced_at: string;
}

export interface ReviewProgressEvent {
  time: string;
  stage: string;
  message: string;
  level: "info" | "success" | "warning" | "error" | string;
}

export interface ReviewResult {
  id: number;
  repo_id: number;
  profile_id: number | null;
  cross_run_id?: number | null;
  commit_hash: string;
  baseline_branch: string;
  branch_name: string;
  status: string;
  summary: string;
  detail: string;
  review_progress: string;
  findings_count: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface TriggerReviewResponse {
  records: ReviewResult[];
  skipped_stale_count: number;
  skipped_stale_branches: string[];
}

export interface PaginatedReviews {
  items: ReviewResult[];
  total: number;
  page: number;
  page_size: number;
}

export interface ReviewQueueStatus {
  review_id: number;
  status: string;
  in_queue: boolean;
  executing: boolean;
  queue_position: number;
  queued_total: number;
  active_total: number;
  max_concurrency: number;
}

export interface CrossRepoReviewRun {
  id: number;
  branch_name: string;
  status: string;
  summary: string;
  detail: string;
  review_progress: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface CrossRepoReviewDetail {
  run: CrossRepoReviewRun;
  children: ReviewResult[];
}

export interface CrossRepoQueueStatus {
  run_id: number;
  status: string;
  queued_total: number;
  active_total: number;
  done_total: number;
  total_children: number;
  max_concurrency: number;
}

export interface CrossRepoPaginatedRuns {
  items: CrossRepoReviewRun[];
  total: number;
  page: number;
  page_size: number;
}

export interface CrossRepoProfileOption {
  id: number;
  repo_id: number;
  repo_name: string;
  name: string;
  enabled: boolean;
}

export interface RepoDetail {
  id: number;
  name: string;
  language: string;
  local_path: string;
  source_type: string;
  baseline_branch: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  notifications: NotificationConfig[];
  profiles: ReviewProfile[];
  polling_config: PollingConfig | null;
  branch_count: number;
  last_review: ReviewResult | null;
}
