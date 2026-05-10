import axios from "axios";
import type {
  RepoListItem,
  RepoDetail,
  NotificationConfig,
  ReviewProfile,
  PollingConfig,
  BranchInfo,
  ReviewResult,
  ReviewQueueStatus,
  CrossRepoReviewDetail,
  CrossRepoQueueStatus,
  CrossRepoPaginatedRuns,
  CrossRepoProfileOption,
  PaginatedReviews,
  TriggerReviewResponse,
} from "../types";
import { getStoredApiKey } from "../contexts/AuthContext";

const api = axios.create({ baseURL: "/api" });

api.interceptors.request.use((config) => {
  const key = getStoredApiKey();
  if (key) {
    config.headers["X-API-Key"] = key;
  }
  return config;
});

// ---- Auth ----

export interface LoginParams {
  api_key: string;
  username?: string;
  password?: string;
}

export interface LoginResult {
  role: string;
  message: string;
}

export const login = (data: LoginParams) =>
  api.post<LoginResult>("/auth/login", data).then((r) => r.data);

// ---- Repositories ----

export const fetchRepos = () =>
  api.get<RepoListItem[]>("/repos").then((r) => r.data);

export const fetchRepo = (id: number) =>
  api.get<RepoDetail>(`/repos/${id}`).then((r) => r.data);

export const createRepo = (data: {
  name: string;
  language?: string;
  local_path: string;
  source_type?: string;
  baseline_branch?: string;
}) => api.post<RepoDetail>("/repos", data).then((r) => r.data);

export const updateRepo = (
  id: number,
  data: Partial<{
    name: string;
    language: string;
    local_path: string;
    source_type: string;
    baseline_branch: string;
    enabled: boolean;
  }>
) => api.put<RepoDetail>(`/repos/${id}`, data).then((r) => r.data);

export const deleteRepo = (id: number) => api.delete(`/repos/${id}`);

export const syncRepo = (id: number) =>
  api.post<{ message: string; branch_count: number }>(`/repos/${id}/sync`).then((r) => r.data);

// ---- Branches ----

export const fetchBranches = (repoId: number) =>
  api.get<BranchInfo[]>(`/repos/${repoId}/branches`).then((r) => r.data);

// ---- Notifications ----

export const fetchNotifications = (repoId: number) =>
  api.get<NotificationConfig[]>(`/repos/${repoId}/notifications`).then((r) => r.data);

export const createNotification = (
  repoId: number,
  data: { type: string; target: string; target_name?: string }
) =>
  api.post<NotificationConfig>(`/repos/${repoId}/notifications`, data).then((r) => r.data);

export const updateNotification = (
  id: number,
  data: Partial<{ type: string; target: string; target_name: string; enabled: boolean }>
) => api.put<NotificationConfig>(`/notifications/${id}`, data).then((r) => r.data);

export const deleteNotification = (id: number) => api.delete(`/notifications/${id}`);

// ---- Profiles ----

export const fetchProfiles = (repoId: number) =>
  api.get<ReviewProfile[]>(`/repos/${repoId}/profiles`).then((r) => r.data);

export const createProfile = (
  repoId: number,
  data: {
    name: string;
    description?: string;
    prompt_template?: string;
    file_patterns?: string;
    exclude_patterns?: string;
    severity_threshold?: string;
  }
) => api.post<ReviewProfile>(`/repos/${repoId}/profiles`, data).then((r) => r.data);

export const updateProfile = (
  id: number,
  data: Partial<{
    name: string;
    description: string;
    prompt_template: string;
    file_patterns: string;
    exclude_patterns: string;
    severity_threshold: string;
    enabled: boolean;
  }>
) => api.put<ReviewProfile>(`/profiles/${id}`, data).then((r) => r.data);

export const deleteProfile = (id: number) => api.delete(`/profiles/${id}`);

// ---- Polling ----

export const fetchPolling = (repoId: number) =>
  api.get<PollingConfig | null>(`/repos/${repoId}/polling`).then((r) => r.data);

export const updatePolling = (
  repoId: number,
  data: { interval_minutes?: number; enabled?: boolean }
) => api.put<PollingConfig>(`/repos/${repoId}/polling`, data).then((r) => r.data);

// ---- Reviews ----

export const fetchReviews = (repoId: number, page = 1, pageSize = 10) =>
  api
    .get<PaginatedReviews>(`/repos/${repoId}/reviews`, { params: { page, page_size: pageSize } })
    .then((r) => r.data);

export const fetchReview = (id: number) =>
  api.get<ReviewResult>(`/reviews/${id}`).then((r) => r.data);

export const fetchReviewQueueStatus = (id: number) =>
  api.get<ReviewQueueStatus>(`/reviews/${id}/queue-status`).then((r) => r.data);

export const clearReviews = (repoId: number) =>
  api.delete<{ deleted: number }>(`/repos/${repoId}/reviews`).then((r) => r.data);

export const triggerReview = (
  repoId: number,
  data: { branch_name?: string; profile_id?: number; profile_ids?: number[] }
) => api.post<TriggerReviewResponse>(`/repos/${repoId}/reviews`, data).then((r) => r.data);

export const triggerCrossRepoReview = (
  data: { branch_name: string; profile_id?: number; profile_ids?: number[] }
) => api.post<CrossRepoReviewDetail>("/reviews/cross-repo", data).then((r) => r.data);

export const fetchCrossRepoReview = (runId: number) =>
  api.get<CrossRepoReviewDetail>(`/reviews/cross-repo/${runId}`).then((r) => r.data);

export const fetchCrossRepoQueueStatus = (runId: number) =>
  api.get<CrossRepoQueueStatus>(`/reviews/cross-repo/${runId}/queue-status`).then((r) => r.data);

export const fetchCrossRepoRuns = (page = 1, pageSize = 10) =>
  api
    .get<CrossRepoPaginatedRuns>("/cross-repo-runs", { params: { page, page_size: pageSize } })
    .then((r) => r.data);

export const searchCrossRepoBranchHints = (q: string, limit = 30) =>
  api
    .get<string[]>("/cross-repo-branches", { params: { q, limit } })
    .then((r) => r.data);

export const fetchCrossRepoProfileOptions = () =>
  api.get<CrossRepoProfileOption[]>("/cross-repo-profile-options").then((r) => r.data);

export const downloadReviewReport = async (reviewId: number) => {
  try {
    const resp = await api.get(`/reviews/${reviewId}/report`, { responseType: "blob" });
    const contentType = String(resp.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("markdown") && !contentType.includes("text/plain")) {
      const text = await resp.data.text();
      throw new Error(text || "下载失败：服务端返回了非 Markdown 内容");
    }

    const disposition = resp.headers["content-disposition"] || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] || `review_${reviewId}.md`;
    const url = URL.createObjectURL(resp.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err: any) {
    const blob = err?.response?.data;
    if (blob && typeof blob.text === "function") {
      const text = await blob.text();
      try {
        const data = JSON.parse(text);
        throw new Error(data?.detail || "下载审查报告失败");
      } catch {
        throw new Error(text || "下载审查报告失败");
      }
    }
    throw new Error(err?.response?.data?.detail || err?.message || "下载审查报告失败");
  }
};

export const downloadCrossRepoReport = async (runId: number) => {
  try {
    const resp = await api.get(`/reviews/cross-repo/${runId}/report`, { responseType: "blob" });
    const contentType = String(resp.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("markdown") && !contentType.includes("text/plain")) {
      const text = await resp.data.text();
      throw new Error(text || "下载失败：服务端返回了非 Markdown 内容");
    }
    const disposition = resp.headers["content-disposition"] || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] || `cross_review_${runId}.md`;
    const url = URL.createObjectURL(resp.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err: any) {
    const blob = err?.response?.data;
    if (blob && typeof blob.text === "function") {
      const text = await blob.text();
      try {
        const data = JSON.parse(text);
        throw new Error(data?.detail || "下载联审报告失败");
      } catch {
        throw new Error(text || "下载联审报告失败");
      }
    }
    throw new Error(err?.response?.data?.detail || err?.message || "下载联审报告失败");
  }
};
