import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dropdown,
  Tag,
  Space,
  Typography,
  Descriptions,
  Table,
  Spin,
  message,
  Divider,
  Empty,
  Modal,
  Select,
  Input,
  Timeline,
  Collapse,
} from "antd";
import {
  SyncOutlined,
  EditOutlined,
  PlusOutlined,
  DeleteOutlined,
  DownloadOutlined,
  BranchesOutlined,
  CodeOutlined,
  BellOutlined,
  FileTextOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  CaretDownOutlined,
  ThunderboltOutlined,
  LoadingOutlined,
  BulbOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "../styles/review-markdown.css";
import {
  fetchRepo,
  fetchBranches,
  fetchReviews,
  fetchReview,
  fetchReviewQueueStatus,
  fetchCrossRepoReview,
  fetchCrossRepoQueueStatus,
  syncRepo,
  triggerReview,
  triggerCrossRepoReview,
  deleteRepo,
  downloadReviewReport,
  clearReviews,
  deleteProfile,
} from "../api/client";
import type {
  BranchInfo,
  PaginatedReviews,
  ReviewProfile,
  ReviewProgressEvent,
  ReviewResult,
  ReviewQueueStatus,
  CrossRepoReviewDetail,
  CrossRepoQueueStatus,
} from "../types";
import StatusCard from "../components/StatusCard";
import RepoFormDialog from "./dialogs/RepoFormDialog";
import ProfileFormDialog from "./dialogs/ProfileFormDialog";
import NotificationFormDialog from "./dialogs/NotificationFormDialog";
import PollingConfigDialog from "./dialogs/PollingConfigDialog";

const { Title, Text } = Typography;

interface Props {
  repoId: number;
  role?: string;
  onDeleted?: () => void;
}

export default function RepoWorkspace({ repoId, role = "viewer", onDeleted }: Props) {
  const isAdmin = role === "admin";
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [showEditRepo, setShowEditRepo] = useState(false);
  const [showProfileDialog, setShowProfileDialog] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ReviewProfile | null>(null);
  const [showAddNotif, setShowAddNotif] = useState(false);
  const [showPolling, setShowPolling] = useState(false);
  const [showCrossReview, setShowCrossReview] = useState(false);
  const [crossBranchName, setCrossBranchName] = useState("");
  const [crossSubmitting, setCrossSubmitting] = useState(false);
  const [crossRunId, setCrossRunId] = useState<number | null>(null);
  const [showCrossDetail, setShowCrossDetail] = useState(false);
  const [reviewDetailId, setReviewDetailId] = useState<number | null>(null);
  const [reviewPage, setReviewPage] = useState(1);
  const [reviewPageSize, setReviewPageSize] = useState(10);
  const [profileDetail, setProfileDetail] = useState<ReviewProfile | null>(null);
  const [branchSearch, setBranchSearch] = useState("");

  const { data: repo, isLoading } = useQuery({
    queryKey: ["repo", repoId],
    queryFn: () => fetchRepo(repoId),
  });

  const { data: branches = [] } = useQuery({
    queryKey: ["branches", repoId],
    queryFn: () => fetchBranches(repoId),
  });

  const emptyPage: PaginatedReviews = { items: [], total: 0, page: 1, page_size: 10 };
  const { data: reviewsData = emptyPage } = useQuery({
    queryKey: ["reviews", repoId, reviewPage, reviewPageSize],
    queryFn: () => fetchReviews(repoId, reviewPage, reviewPageSize),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.items?.some((r) => r.status === "reviewing")) return 3000;
      return false;
    },
  });
  const reviews = reviewsData.items;
  const { data: reviewDetail } = useQuery({
    queryKey: ["review", reviewDetailId],
    queryFn: () => fetchReview(reviewDetailId as number),
    enabled: !!reviewDetailId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "reviewing" ? 2000 : false;
    },
  });
  const { data: queueStatus } = useQuery({
    queryKey: ["review-queue-status", reviewDetailId],
    queryFn: () => fetchReviewQueueStatus(reviewDetailId as number),
    enabled: !!reviewDetailId,
    refetchInterval: (query) => {
      const st = query.state.data?.status;
      return st === "reviewing" ? 2000 : false;
    },
  });
  const { data: crossDetail } = useQuery({
    queryKey: ["cross-review", crossRunId],
    queryFn: () => fetchCrossRepoReview(crossRunId as number),
    enabled: !!crossRunId,
    refetchInterval: (query) => {
      const st = query.state.data?.run?.status;
      return st === "reviewing" ? 2500 : false;
    },
  });
  const { data: crossQueue } = useQuery({
    queryKey: ["cross-review-queue", crossRunId],
    queryFn: () => fetchCrossRepoQueueStatus(crossRunId as number),
    enabled: !!crossRunId,
    refetchInterval: (query) => {
      const st = query.state.data?.status;
      return st === "reviewing" ? 2500 : false;
    },
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["repo", repoId] });
    queryClient.invalidateQueries({ queryKey: ["branches", repoId] });
    queryClient.invalidateQueries({ queryKey: ["reviews", repoId] });
    queryClient.invalidateQueries({ queryKey: ["repos"] });
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await syncRepo(repoId);
      message.success(`同步完成，共 ${res.branch_count} 个分支`);
      invalidateAll();
    } catch {
      message.error("同步失败");
    } finally {
      setSyncing(false);
    }
  };

  const [reviewing, setReviewing] = useState(false);
  const [showBranchReview, setShowBranchReview] = useState(false);
  const [triggerMode, setTriggerMode] = useState<"all" | "branch">("all");
  const [selectedBranch, setSelectedBranch] = useState<string | undefined>(undefined);
  const [triggerProfileIds, setTriggerProfileIds] = useState<number[]>([]);
  const [lastTriggerProfileIds, setLastTriggerProfileIds] = useState<number[]>([]);
  const [tipModal, setTipModal] = useState<{ title: string; content: string } | null>(null);

  const handleTriggerAll = async () => {
    setTriggerMode("all");
    setSelectedBranch(undefined);
    setTriggerProfileIds(lastTriggerProfileIds);
    setShowBranchReview(true);
  };

  const handleTriggerBranch = async (branchName?: string) => {
    setTriggerMode("branch");
    setSelectedBranch(branchName);
    setTriggerProfileIds(lastTriggerProfileIds);
    setShowBranchReview(true);
  };

  const handleSubmitTrigger = async () => {
    if (triggerMode === "branch" && !selectedBranch) {
      message.warning("请选择一个分支");
      return;
    }
    setReviewing(true);
    setShowBranchReview(false);
    try {
      const resp = await triggerReview(repoId, {
        branch_name: triggerMode === "branch" ? selectedBranch : undefined,
        profile_ids: triggerProfileIds.length > 0 ? triggerProfileIds : undefined,
      });
      if (triggerMode === "branch" && selectedBranch) {
        message.success(`分支 ${selectedBranch} 已创建 ${resp.records.length} 条审查任务，审查中...`);
      } else {
        message.success(`已创建 ${resp.records.length} 条审查任务，审查中...`);
      }
      setLastTriggerProfileIds(triggerProfileIds);
      if (resp.skipped_stale_count > 0) {
        setTipModal({
          title: "部分分支已跳过",
          content: `${resp.skipped_stale_count} 个分支因最后更新超过 5 天被自动跳过。如需审查这些分支，请使用「审查指定分支」手动触发。`,
        });
      }
      setReviewPage(1);
      invalidateAll();
    } catch (err: any) {
      const detail = err?.response?.data?.detail || "触发审查失败";
      setTipModal({ title: "审查提示", content: detail });
    } finally {
      setReviewing(false);
    }
  };

  const handleTriggerCrossReview = async () => {
    const branch = crossBranchName.trim();
    if (!branch) {
      message.warning("请输入需要联审的分支名");
      return;
    }
    setCrossSubmitting(true);
    try {
      const resp = await triggerCrossRepoReview({ branch_name: branch });
      setCrossRunId(resp.run.id);
      setShowCrossReview(false);
      setShowCrossDetail(true);
      message.success(`跨仓库联审已创建：${resp.children.length} 个子任务`);
      setReviewPage(1);
      invalidateAll();
    } catch (err: any) {
      const detail = err?.response?.data?.detail || "触发跨仓库联审失败";
      setTipModal({ title: "联审提示", content: detail });
    } finally {
      setCrossSubmitting(false);
    }
  };

  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deletingRepo, setDeletingRepo] = useState(false);

  const doClearReviews = async () => {
    setClearing(true);
    try {
      const res = await clearReviews(repoId);
      message.success(`已清空 ${res.deleted} 条审查记录`);
      setReviewPage(1);
      invalidateAll();
    } catch {
      message.error("清空失败");
    } finally {
      setClearing(false);
      setShowClearConfirm(false);
    }
  };

  const handleDownloadReport = async (reviewId: number) => {
    try {
      await downloadReviewReport(reviewId);
    } catch (err: any) {
      message.error(err?.message || "下载审查报告失败");
    }
  };


  const handleDelete = () => {
    setShowDeleteConfirm(true);
  };

  const doDeleteRepo = async () => {
    setDeletingRepo(true);
    try {
      await deleteRepo(repoId);
      message.success("仓库已删除");
      queryClient.invalidateQueries({ queryKey: ["repos"] });
      onDeleted?.();
      setShowDeleteConfirm(false);
    } catch {
      message.error("删除失败");
    } finally {
      setDeletingRepo(false);
    }
  };

  const selectedReview = reviewDetail || reviews.find((r) => r.id === reviewDetailId);
  const reviewProgress = useMemo<ReviewProgressEvent[]>(() => {
    if (!selectedReview?.review_progress) return [];
    try {
      const parsed = JSON.parse(selectedReview.review_progress);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [selectedReview?.review_progress]);
  const systemProgress = useMemo<ReviewProgressEvent[]>(
    () =>
      reviewProgress.filter(
        (e) =>
          e.stage !== "ai_thought_summary" &&
          e.stage !== "ai_thought_step" &&
          e.stage !== "tool_call" &&
          e.stage !== "llm_stream_chunk" &&
          e.stage !== "heartbeat"
      ),
    [reviewProgress]
  );
  const heartbeatEvent = useMemo<ReviewProgressEvent | null>(() => {
    const all = reviewProgress.filter((e) => e.stage === "heartbeat");
    return all.length > 0 ? all[all.length - 1] : null;
  }, [reviewProgress]);
  const aiThoughtSummary = useMemo(() => {
    const thought = reviewProgress.find((e) => e.stage === "ai_thought_summary");
    if (thought?.message) return thought.message;
    return selectedReview?.summary || "暂无思考摘要";
  }, [reviewProgress, selectedReview?.summary]);
  const completionState = useMemo(() => {
    if (!selectedReview) return "未知";
    if (selectedReview.status === "reviewing") return "进行中";
    if (selectedReview.status === "passed") return "已完成（通过）";
    if (selectedReview.status === "failed") return "已完成（不通过）";
    if (selectedReview.status === "error") return "已完成（错误）";
    return selectedReview.status;
  }, [selectedReview]);
  const aiProcessItems = useMemo(() => {
    if (!selectedReview) return [];
    const items: Array<{
      key: string;
      kind: "thought" | "tool" | "status";
      title: string;
      subtitle: string;
      content: string;
      time?: string;
      done: boolean;
    }> = [];

    const stageMeta: Record<
      string,
      { kind: "thought" | "tool" | "status"; title: string; subtitle: string }
    > = {
      ai_thought_summary: {
        kind: "thought",
        title: "规划下一步",
        subtitle: "我判断下一步应先读取关键上下文后再做结论。",
      },
      ai_thought_step: {
        kind: "thought",
        title: "思考",
        subtitle: "模型在审查中的推理步骤。",
      },
      tool_call: {
        kind: "tool",
        title: "工具",
        subtitle: "调用工具读取或检索代码信息。",
      },
      queued: {
        kind: "status",
        title: "进入队列",
        subtitle: "任务已创建，等待执行。",
      },
      waiting_repo_lock: {
        kind: "status",
        title: "等待执行锁",
        subtitle: "同仓库任务串行执行，避免冲突。",
      },
      start: {
        kind: "status",
        title: "开始执行",
        subtitle: "已开始准备审查上下文。",
      },
      llm_review: {
        kind: "status",
        title: "模型分析中",
        subtitle: "模型正在进行代码分析。",
      },
      completed: {
        kind: "status",
        title: "完成状态",
        subtitle: "任务执行完成情况。",
      },
      error: {
        kind: "status",
        title: "完成状态",
        subtitle: "任务执行完成情况。",
      },
    };

    // Keep timeline sequence exactly as generated by backend events.
    reviewProgress.forEach((e, idx) => {
      // AI analysis panel should only show model thinking and tool usage.
      if (!(e.stage === "ai_thought_summary" || e.stage === "ai_thought_step" || e.stage === "tool_call")) {
        return;
      }
      const meta = stageMeta[e.stage] || {
        kind: "status" as const,
        title: "执行状态",
        subtitle: "任务执行过程事件。",
      };
      const isDone =
        selectedReview.status !== "reviewing" ||
        idx < reviewProgress.length - 1;

      items.push({
        key: `${e.stage}-${idx}-${e.time || ""}`,
        kind: meta.kind,
        title: meta.title,
        subtitle: meta.subtitle,
        content: e.message,
        time: e.time,
        done: isDone,
      });
    });

    if (items.length === 0 && aiThoughtSummary) {
      items.push({
        key: "fallback-thought",
        kind: "thought",
        title: "规划下一步",
        subtitle: "模型给出的简要思路。",
        content: aiThoughtSummary,
        done: selectedReview.status !== "reviewing",
      });
    }

    return items;
  }, [selectedReview, aiThoughtSummary, reviewProgress, completionState]);
  const queueHint = useMemo(() => {
    if (!queueStatus) return "";
    if (queueStatus.executing) {
      return `正在执行（并发 ${queueStatus.active_total}/${queueStatus.max_concurrency}）`;
    }
    if (queueStatus.in_queue) {
      const ahead = Math.max(queueStatus.queue_position - 1, 0);
      return `排队中（前方 ${ahead} 个任务，队列总长 ${queueStatus.queued_total}）`;
    }
    if (selectedReview?.status === "reviewing") {
      return "任务状态同步中...";
    }
    return "";
  }, [queueStatus, selectedReview?.status]);
  const filteredBranches = useMemo(() => {
    const keyword = branchSearch.trim().toLowerCase();
    if (!keyword) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(keyword));
  }, [branches, branchSearch]);

  if (isLoading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!repo) {
    return (
      <div style={{ padding: 24 }}>
        <Empty
          description="仓库详情加载失败，请重试"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        >
          <Button
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ["repo", repoId] });
            }}
          >
            重新加载
          </Button>
        </Empty>
      </div>
    );
  }

  const lastReview = repo.last_review;
  const lastReviewLabel = lastReview
    ? lastReview.status === "passed"
      ? "通过"
      : lastReview.status === "failed"
      ? "不通过"
      : lastReview.status
    : "无";

  const reviewStatusColor =
    lastReview?.status === "passed"
      ? "green"
      : lastReview?.status === "failed"
      ? "red"
      : "default";

  const pollingCfg = repo.polling_config;
  const pollingDesc = pollingCfg?.enabled
    ? `每 ${pollingCfg.interval_minutes} 分钟`
    : "未启用";
  const pollingLastSuccess = pollingCfg?.last_poll_at
    ? `上次: ${pollingCfg.last_poll_status === "success" ? "成功" : "失败"} ${dayjs(pollingCfg.last_poll_at).format("M/D HH:mm")}`
    : "";

  return (
    <div style={{ padding: 24 }}>
      {/* Header */}
      <div style={{ marginBottom: 4 }}>
        <Tag color="purple" style={{ fontSize: 11, marginBottom: 8 }}>
          REPOSITORY WORKSPACE
        </Tag>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 12,
        }}
      >
        <div>
          <Title level={4} style={{ margin: 0 }}>
            {repo.name}
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {repo.local_path}
          </Text>
        </div>
        <Space>
          {isAdmin && (
            <Button icon={<EditOutlined />} onClick={() => setShowEditRepo(true)}>
              编辑仓库
            </Button>
          )}
          {isAdmin && (
            <Button
              icon={<SyncOutlined spin={syncing} />}
              onClick={handleSync}
              loading={syncing}
            >
              立即同步
            </Button>
          )}
          {isAdmin && (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => { setEditingProfile(null); setShowProfileDialog(true); }}
            >
              创建 Profile
            </Button>
          )}
          {isAdmin && (
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={handleDelete}
            >
              删除仓库
            </Button>
          )}
        </Space>
      </div>

      {/* Tags */}
      <Space size={[8, 8]} wrap style={{ marginBottom: 20 }}>
        <Tag color={repo.enabled ? "purple" : "default"}>
          {repo.enabled ? "仓库已启用" : "仓库已停用"}
        </Tag>
        <Tag>{repo.source_type}</Tag>
        <Tag>默认基线 {repo.baseline_branch}</Tag>
        <Tag>{repo.profiles.length} 个 profile</Tag>
        <Tag color={reviewStatusColor}>最近审查: {lastReviewLabel}</Tag>
      </Space>

      {/* Status Cards */}
      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 24,
          flexWrap: "wrap",
        }}
      >
        <StatusCard
          title="代码源"
          description={`${repo.local_path}\n${repo.source_type} · 默认基线 ${repo.baseline_branch}`}
          status="connected"
          icon={<CodeOutlined />}
        />
        <StatusCard
          title="查询投递"
          description={
            repo.notifications.length > 0
              ? `${repo.notifications.map((n) => `${n.target_name || n.type}`).join(", ")}\n${repo.notifications.length} 条通知渠道`
              : "未配置通知渠道"
          }
          status={repo.notifications.length > 0 ? "configured" : "none"}
          icon={<BellOutlined />}
        />
        <StatusCard
          title="审查模板"
          description={
            repo.profiles.length > 0
              ? `${repo.profiles.length} 个 profile\n最近结果: ${lastReviewLabel}`
              : "未配置审查模板"
          }
          status={repo.profiles.length > 0 ? "configured" : "none"}
          icon={<FileTextOutlined />}
        />
        <StatusCard
          title="自动轮询"
          description={`${pollingDesc}\n${pollingLastSuccess}`}
          status={pollingCfg?.enabled ? "enabled" : "disabled"}
          icon={<ClockCircleOutlined />}
        />
      </div>

      {/* Repo Config Section */}
      <Divider orientation="left" style={{ fontSize: 15, fontWeight: 600 }}>
        仓库配置
      </Divider>
      <Descriptions bordered size="small" column={2} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="来源类型">{repo.source_type}</Descriptions.Item>
        <Descriptions.Item label="Profile 数量">
          {repo.profiles.length} 个 profile · {repo.enabled ? "已启用" : "已停用"}
        </Descriptions.Item>
        <Descriptions.Item label="基线分支">{repo.baseline_branch}</Descriptions.Item>
        <Descriptions.Item label="语言">{repo.language || "-"}</Descriptions.Item>
        <Descriptions.Item label="本地路径" span={2}>{repo.local_path}</Descriptions.Item>
      </Descriptions>
      {isAdmin && (
        <Space style={{ marginBottom: 8 }}>
          <Button size="small" onClick={() => setShowEditRepo(true)}>
            编辑仓库
          </Button>
          <Button size="small" onClick={() => setShowAddNotif(true)}>
            配置通知
          </Button>
          <Button size="small" onClick={() => setShowPolling(true)}>
            轮询设置
          </Button>
        </Space>
      )}

      {/* Branches Section */}
      <Divider orientation="left" style={{ fontSize: 15, fontWeight: 600 }}>
        远端分支
      </Divider>
      <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
        当前已加载 {branches.length} 个分支，可按需拉起审查。
      </Text>
      <Input
        value={branchSearch}
        onChange={(e) => setBranchSearch(e.target.value)}
        placeholder="按分支名搜索"
        allowClear
        style={{ marginBottom: 8, maxWidth: 360 }}
      />
      <Table<BranchInfo>
        dataSource={filteredBranches}
        rowKey="id"
        size="small"
        pagination={{ pageSize: 10, size: "small" }}
        style={{ marginBottom: 16 }}
        columns={[
          {
            title: "分支名",
            dataIndex: "name",
            key: "name",
            render: (v: string) => (
              <Space>
                <BranchesOutlined />
                <Text copyable={{ text: v }}>{v}</Text>
              </Space>
            ),
          },
          {
            title: "最新提交",
            dataIndex: "last_commit_hash",
            key: "commit",
            width: 100,
            render: (v: string) => <Text code>{v?.slice(0, 7)}</Text>,
          },
          {
            title: "提交信息",
            dataIndex: "last_commit_message",
            key: "msg",
            ellipsis: true,
          },
          {
            title: "作者",
            dataIndex: "last_commit_author",
            key: "author",
            width: 120,
          },
          {
            title: "时间",
            dataIndex: "last_commit_date",
            key: "date",
            width: 160,
            defaultSortOrder: "descend",
            sorter: (a: BranchInfo, b: BranchInfo) => {
              if (!a.last_commit_date) return -1;
              if (!b.last_commit_date) return 1;
              return new Date(a.last_commit_date).getTime() - new Date(b.last_commit_date).getTime();
            },
            render: (v: string) => (v ? dayjs(v).format("YYYY-MM-DD HH:mm") : "-"),
          },
          {
            title: "操作",
            key: "action",
            width: 90,
            render: (_: unknown, record: BranchInfo) =>
              record.name === repo.baseline_branch ? (
                <Tag>基线</Tag>
              ) : (
                <Button
                  type="link"
                  size="small"
                  icon={<ThunderboltOutlined />}
                  onClick={() => handleTriggerBranch(record.name)}
                >
                  审查
                </Button>
              ),
          },
        ]}
      />
      {isAdmin && (
        <Button icon={<SyncOutlined />} onClick={handleSync} loading={syncing}>
          同步仓库
        </Button>
      )}

      {/* Profiles Section */}
      <Divider orientation="left" style={{ fontSize: 15, fontWeight: 600 }}>
        审查 Profile
      </Divider>
      {repo.profiles.length === 0 ? (
        <Empty description="暂无 Profile" style={{ margin: "20px 0" }} />
      ) : (
        <Table
          dataSource={repo.profiles}
          rowKey="id"
          size="small"
          pagination={false}
          style={{ marginBottom: 16 }}
          onRow={(record) => ({
            onClick: () => setProfileDetail(record as ReviewProfile),
            style: { cursor: "pointer" },
          })}
          columns={[
            { title: "名称", dataIndex: "name", key: "name" },
            { title: "描述", dataIndex: "description", key: "desc", ellipsis: true },
            {
              title: "严重度阈值",
              dataIndex: "severity_threshold",
              key: "sev",
              width: 100,
            },
            {
              title: "状态",
              dataIndex: "enabled",
              key: "enabled",
              width: 80,
              render: (v: boolean) => (
                <Tag color={v ? "green" : "default"}>{v ? "启用" : "停用"}</Tag>
              ),
            },
            {
              title: "操作",
              key: "action",
              width: isAdmin ? 180 : 80,
              render: (_: unknown, record: unknown) => {
                const p = record as ReviewProfile;
                return (
                  <Space size={0}>
                    <Button
                      type="link"
                      size="small"
                      icon={<FileTextOutlined />}
                      onClick={(e) => { e.stopPropagation(); setProfileDetail(p); }}
                    >
                      查看
                    </Button>
                    {isAdmin && (
                      <>
                        <Button
                          type="link"
                          size="small"
                          icon={<EditOutlined />}
                          onClick={(e) => { e.stopPropagation(); setEditingProfile(p); setShowProfileDialog(true); }}
                        >
                          编辑
                        </Button>
                        <Button
                          type="link"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={(e) => {
                            e.stopPropagation();
                            Modal.confirm({
                              title: "确认删除",
                              content: `确定要删除 Profile「${p.name}」吗？`,
                              okText: "删除",
                              okType: "danger",
                              cancelText: "取消",
                              onOk: async () => {
                                await deleteProfile(p.id);
                                queryClient.invalidateQueries({ queryKey: ["repo", repoId] });
                              },
                            });
                          }}
                        >
                          删除
                        </Button>
                      </>
                    )}
                  </Space>
                );
              },
            },
          ]}
        />
      )}
      {isAdmin && (
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => { setEditingProfile(null); setShowProfileDialog(true); }}
        >
          添加 Profile
        </Button>
      )}

      {/* Reviews Section */}
      <Divider orientation="left" style={{ fontSize: 15, fontWeight: 600 }}>
        审查记录
      </Divider>
      {reviews.length === 0 && reviewsData.total === 0 ? (
        <Empty description="暂无审查记录" style={{ margin: "20px 0" }} />
      ) : (
        <Table<ReviewResult>
          dataSource={reviews}
          rowKey="id"
          size="small"
          pagination={{
            current: reviewPage,
            pageSize: reviewPageSize,
            total: reviewsData.total,
            size: "small",
            showSizeChanger: true,
            pageSizeOptions: ["10", "20", "50"],
            showTotal: (total) => `共 ${total} 条`,
            onChange: (page, pageSize) => {
              setReviewPage(page);
              setReviewPageSize(pageSize);
            },
          }}
          style={{ marginBottom: 16 }}
          onRow={(record) => ({
            onClick: () => setReviewDetailId(record.id),
            style: { cursor: "pointer" },
          })}
          columns={[
            {
              title: "状态",
              dataIndex: "status",
              key: "status",
              width: 80,
              render: (v: string) => {
                const icon =
                  v === "passed" ? (
                    <CheckCircleOutlined style={{ color: "#52c41a" }} />
                  ) : v === "failed" ? (
                    <CloseCircleOutlined style={{ color: "#ff4d4f" }} />
                  ) : v === "reviewing" ? (
                    <LoadingOutlined style={{ color: "#1677ff" }} />
                  ) : v === "error" ? (
                    <ExclamationCircleOutlined style={{ color: "#ff4d4f" }} />
                  ) : (
                    <ClockCircleOutlined style={{ color: "#faad14" }} />
                  );
                const label: Record<string, string> = {
                  reviewing: "审查中",
                  passed: "通过",
                  failed: "不通过",
                  error: "错误",
                  pending: "待审查",
                };
                return (
                  <Space>
                    {icon}
                    {label[v] || v}
                  </Space>
                );
              },
            },
            {
              title: "Commit",
              dataIndex: "commit_hash",
              key: "commit",
              width: 100,
              render: (v: string) => <Text code>{v?.slice(0, 7)}</Text>,
            },
            {
              title: "分支",
              dataIndex: "branch_name",
              key: "branch",
              width: 150,
            },
            {
              title: "摘要",
              dataIndex: "summary",
              key: "summary",
              ellipsis: true,
            },
            {
              title: "问题数",
              dataIndex: "findings_count",
              key: "findings",
              width: 80,
            },
            {
              title: "时间",
              dataIndex: "created_at",
              key: "date",
              width: 160,
              render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm"),
            },
            {
              title: "操作",
              key: "action",
              width: 80,
              render: (_: unknown, record: ReviewResult) =>
                record.status === "reviewing" ? (
                  <LoadingOutlined style={{ color: "#1677ff" }} />
                ) : (
                  <Button
                    type="link"
                    size="small"
                    icon={<DownloadOutlined />}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await handleDownloadReport(record.id);
                    }}
                  >
                    报告
                  </Button>
                ),
            },
          ]}
        />
      )}
      <Space direction="vertical" size={4}>
        <Space size={12}>
          <Dropdown.Button
            type="primary"
            loading={reviewing}
            onClick={handleTriggerAll}
            icon={<CaretDownOutlined />}
            menu={{
              items: [
                {
                  key: "all",
                  icon: <ThunderboltOutlined />,
                  label: "审查所有分支（与自动轮询策略相同）",
                  onClick: handleTriggerAll,
                },
                {
                  key: "branch",
                  icon: <BranchesOutlined />,
                  label: "审查指定分支",
                  onClick: () => {
                    handleTriggerBranch(undefined);
                  },
                },
              ],
            }}
          >
            <ThunderboltOutlined /> 手动触发审查
          </Dropdown.Button>
          {isAdmin && reviewsData.total > 0 && (
            <Button danger icon={<DeleteOutlined />} onClick={() => setShowClearConfirm(true)}>
              清空审查记录
            </Button>
          )}
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          审查所有分支时，最后更新超过 5 天的分支将被自动跳过。如需审查，请使用「审查指定分支」或分支列表中的审查按钮。
        </Text>
      </Space>

      {/* Branch Selection Modal */}
      <Modal
        title={triggerMode === "branch" ? "选择分支并配置审查" : "配置全量分支审查"}
        open={showBranchReview}
        onCancel={() => setShowBranchReview(false)}
        onOk={handleSubmitTrigger}
        okText="开始审查"
        cancelText="取消"
        confirmLoading={reviewing}
        okButtonProps={{ disabled: triggerMode === "branch" && !selectedBranch }}
      >
        <div style={{ marginBottom: 8 }}>
          <Typography.Text type="secondary">
            {triggerMode === "branch"
              ? `将选中分支的最新 commit 与基线分支（${repo.baseline_branch}）进行 diff 对比并审查`
              : `将按照自动轮询策略审查所有需要审查的分支（基线：${repo.baseline_branch}）`}
          </Typography.Text>
        </div>
        {triggerMode === "branch" && (
          <Select
            showSearch
            style={{ width: "100%", marginBottom: 10 }}
            placeholder="搜索并选择分支"
            value={selectedBranch}
            onChange={setSelectedBranch}
            filterOption={(input, option) =>
              (option?.label ?? "").toLowerCase().includes(input.toLowerCase())
            }
            options={branches
              .filter((b) => b.name !== repo.baseline_branch)
              .map((b) => ({
                value: b.name,
                label: `${b.name}  (${b.last_commit_hash?.slice(0, 7)} · ${b.last_commit_date ? dayjs(b.last_commit_date).format("MM-DD HH:mm") : "-"})`,
              }))}
          />
        )}
        <Select
          mode="multiple"
          allowClear
          style={{ width: "100%" }}
          placeholder="可选：选择本次审查要使用的 Profile（默认不使用 Profile）"
          value={triggerProfileIds}
          onChange={(vals) => setTriggerProfileIds(vals)}
          options={repo.profiles
            .filter((p) => p.enabled)
            .map((p) => ({ value: p.id, label: p.name }))}
        />
      </Modal>

      {/* Cross-repo review trigger modal */}
      <Modal
        title="跨仓库同名分支联审"
        open={showCrossReview}
        onCancel={() => setShowCrossReview(false)}
        onOk={handleTriggerCrossReview}
        okText="开始联审"
        confirmLoading={crossSubmitting}
      >
        <div style={{ marginBottom: 8 }}>
          <Text type="secondary">
            输入分支名后，系统会在所有仓库中查找同名分支并统一触发联审。
          </Text>
        </div>
        <Input
          style={{ width: "100%" }}
          value={crossBranchName}
          placeholder="例如：feature/cnq_custom_picking_template"
          onChange={(e) => setCrossBranchName(e.target.value)}
          list="cross-branch-list"
        />
        <datalist id="cross-branch-list">
          {Array.from(new Set(branches.map((b) => b.name))).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Modal>

      {/* Cross-repo review detail modal */}
      <Modal
        title={`跨仓库联审详情 #${crossDetail?.run.id ?? crossRunId ?? ""}`}
        open={showCrossDetail}
        onCancel={() => setShowCrossDetail(false)}
        width={980}
        footer={<Button onClick={() => setShowCrossDetail(false)}>关闭</Button>}
      >
        {!crossDetail ? (
          <div style={{ textAlign: "center", padding: "40px 0" }}>
            <Spin />
          </div>
        ) : (
          <>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="目标分支">{crossDetail.run.branch_name}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={crossDetail.run.status === "passed" ? "green" : crossDetail.run.status === "reviewing" ? "processing" : "volcano"}>
                  {crossDetail.run.status}
                </Tag>
              </Descriptions.Item>
            </Descriptions>

            {crossQueue && (
              <div style={{ marginTop: 10 }}>
                <Tag color={crossQueue.status === "reviewing" ? "processing" : "default"}>
                  队列：排队 {crossQueue.queued_total} / 执行中 {crossQueue.active_total} / 已完成 {crossQueue.done_total} / 总数 {crossQueue.total_children}
                </Tag>
              </div>
            )}

            <Divider orientation="left">子仓库审查记录</Divider>
            <Table<ReviewResult>
              dataSource={crossDetail.children}
              rowKey="id"
              size="small"
              pagination={false}
              columns={[
                {
                  title: "记录ID",
                  dataIndex: "id",
                  width: 90,
                  render: (v: number) => <Text code>#{v}</Text>,
                },
                {
                  title: "仓库ID",
                  dataIndex: "repo_id",
                  width: 90,
                  render: (v: number) => <Text>{v}</Text>,
                },
                {
                  title: "分支",
                  dataIndex: "branch_name",
                  width: 220,
                },
                {
                  title: "状态",
                  dataIndex: "status",
                  width: 110,
                },
                {
                  title: "问题数",
                  dataIndex: "findings_count",
                  width: 90,
                },
                {
                  title: "操作",
                  width: 100,
                  render: (_: unknown, r: ReviewResult) => (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => {
                        setShowCrossDetail(false);
                        setReviewDetailId(r.id);
                      }}
                    >
                      查看详情
                    </Button>
                  ),
                },
              ]}
            />

            <Divider orientation="left">联审总报告</Divider>
            <div className="review-markdown" style={{ maxHeight: 360, overflow: "auto", background: "#fafafa", borderRadius: 6, padding: "10px 12px" }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {crossDetail.run.detail || "暂无联审报告"}
              </ReactMarkdown>
            </div>
          </>
        )}
      </Modal>

      {/* Review Detail Modal */}
      <Modal
        title={`审查详情 #${selectedReview?.id ?? ""}`}
        open={!!reviewDetailId}
        onCancel={() => setReviewDetailId(null)}
        width={800}
        footer={
          selectedReview && selectedReview.status !== "reviewing" ? (
            <Button
              icon={<DownloadOutlined />}
              onClick={async () => {
                await handleDownloadReport(selectedReview.id);
              }}
            >
              下载审查报告
            </Button>
          ) : null
        }
      >
        {selectedReview && (
          <div>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="状态">
                <Tag
                  color={
                    selectedReview.status === "passed"
                      ? "green"
                      : selectedReview.status === "failed"
                      ? "red"
                      : selectedReview.status === "error"
                      ? "volcano"
                      : "orange"
                  }
                >
                  {selectedReview.status === "passed" ? "通过" : selectedReview.status === "failed" ? "不通过" : selectedReview.status === "error" ? "错误" : selectedReview.status}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Commit">
                <Typography.Text code copyable>
                  {selectedReview.commit_hash?.slice(0, 8)}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="分支">
                {selectedReview.branch_name}
              </Descriptions.Item>
              <Descriptions.Item label="问题数">
                {selectedReview.findings_count}
              </Descriptions.Item>
              <Descriptions.Item label="摘要" span={2}>
                {selectedReview.summary}
              </Descriptions.Item>
            </Descriptions>

            <Divider orientation="left" style={{ fontSize: 14, marginTop: 16 }}>
              AI 分析过程
            </Divider>
            <Collapse
              defaultActiveKey={["ai-flow"]}
              size="small"
              items={[
                {
                  key: "ai-flow",
                  label: (
                    <Space>
                      <Text strong>展开 / 收起分析过程</Text>
                      <Text type="secondary">这里仅展示 AI 思考与工具调用，不包含系统队列事件。</Text>
                    </Space>
                  ),
                  children: (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                        position: "relative",
                        marginLeft: 8,
                        paddingLeft: 18,
                        borderLeft: "2px solid #e6f4ff",
                      }}
                    >
                      {aiProcessItems.length === 0 ? (
                        <Text type="secondary">暂无 AI 分析过程数据</Text>
                      ) : (
                        aiProcessItems.map((item) => (
                          <div
                            key={item.key}
                            style={{
                              position: "relative",
                              border: "1px solid #f0f0f0",
                              borderRadius: 10,
                              padding: "10px 12px",
                              background: "#fff",
                            }}
                          >
                            <div
                              style={{
                                position: "absolute",
                                left: -24,
                                top: 16,
                                width: 10,
                                height: 10,
                                borderRadius: "50%",
                                background:
                                  item.kind === "thought"
                                    ? "#9254de"
                                    : item.kind === "tool"
                                    ? "#13c2c2"
                                    : "#1677ff",
                                border: "2px solid #fff",
                                boxShadow: "0 0 0 1px #d9d9d9",
                              }}
                            />
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginBottom: 6,
                              }}
                            >
                              <Space size={8}>
                                <Space size={4}>
                                  {item.kind === "thought" ? (
                                    <BulbOutlined style={{ color: "#9254de" }} />
                                  ) : item.kind === "tool" ? (
                                    <ToolOutlined style={{ color: "#13c2c2" }} />
                                  ) : (
                                    <CheckCircleOutlined style={{ color: "#1677ff" }} />
                                  )}
                                  <Text strong>{item.title}</Text>
                                </Space>
                                {item.time && (
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    {dayjs(item.time).format("YYYY-MM-DD HH:mm:ss")}
                                  </Text>
                                )}
                              </Space>
                              <Tag color={item.done ? "green" : "processing"}>
                                {item.done ? "已完成" : "进行中"}
                              </Tag>
                            </div>
                            <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
                              {item.subtitle}
                            </Text>
                            {item.kind === "tool" ? (
                              <Text code>{item.content}</Text>
                            ) : (
                              <Text>{item.content}</Text>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  ),
                },
              ]}
            />

            <Divider orientation="left" style={{ fontSize: 14, marginTop: 16 }}>
              完成状态
            </Divider>
            <Space size={8} style={{ marginBottom: 8 }}>
              <Tag color={selectedReview.status === "passed" ? "green" : selectedReview.status === "reviewing" ? "processing" : selectedReview.status === "failed" ? "red" : "volcano"}>
                {completionState}
              </Tag>
              {selectedReview.completed_at && (
                <Text type="secondary">
                  完成时间：{dayjs(selectedReview.completed_at).format("YYYY-MM-DD HH:mm:ss")}
                </Text>
              )}
            </Space>

            <Divider orientation="left" style={{ fontSize: 14, marginTop: 16 }}>
              审查进度
            </Divider>
            {selectedReview.status === "reviewing" && heartbeatEvent && (
              <div
                style={{
                  marginBottom: 10,
                  padding: "8px 10px",
                  borderRadius: 6,
                  background: "#e6f4ff",
                  border: "1px solid #91caff",
                }}
              >
                <Text style={{ color: "#0958d9" }}>
                  任务仍在运行（最近心跳：{dayjs(heartbeatEvent.time).format("YYYY-MM-DD HH:mm:ss")}）
                </Text>
              </div>
            )}
            {selectedReview.status === "reviewing" && (
              <div style={{ marginBottom: 10 }}>
                <Tag color={queueStatus?.executing ? "processing" : "gold"}>{queueHint || "排队信息获取中..."}</Tag>
              </div>
            )}
            {systemProgress.length === 0 ? (
              <Text type="secondary">暂无进度信息</Text>
            ) : (
              <Timeline
                items={systemProgress.map((e) => ({
                  color:
                    e.level === "error"
                      ? "red"
                      : e.level === "success"
                      ? "green"
                      : e.level === "warning"
                      ? "orange"
                      : "blue",
                  children: (
                    <div>
                      <div style={{ fontWeight: 500 }}>
                        {e.message}
                      </div>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {dayjs(e.time).format("YYYY-MM-DD HH:mm:ss")} · {e.stage}
                      </Text>
                    </div>
                  ),
                }))}
              />
            )}

            {selectedReview.status === "reviewing" ? (
              <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
                <Spin size="small" /> <Text type="secondary">审查进行中，进度会自动刷新</Text>
              </div>
            ) : (
              <>
                <Divider />
                <div
                  className="review-markdown"
                  style={{
                    maxHeight: 500,
                    overflow: "auto",
                    padding: "12px 16px",
                    background: "#fafafa",
                    borderRadius: 6,
                    fontSize: 14,
                    lineHeight: 1.7,
                  }}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {selectedReview.detail || "暂无详细内容"}
                  </ReactMarkdown>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* Tip Modal (state-driven, not static method) */}
      <Modal
        title={tipModal?.title}
        open={!!tipModal}
        onOk={() => setTipModal(null)}
        onCancel={() => setTipModal(null)}
        cancelButtonProps={{ style: { display: "none" } }}
        okText="知道了"
      >
        <p>{tipModal?.content}</p>
      </Modal>

      {/* Clear Reviews Confirm Modal */}
      <Modal
        title="确认清空审查记录"
        open={showClearConfirm}
        onCancel={() => setShowClearConfirm(false)}
        onOk={doClearReviews}
        okText="清空"
        okType="danger"
        okButtonProps={{ loading: clearing }}
        cancelText="取消"
      >
        <p>确定要清空仓库「{repo.name}」的所有审查记录吗？此操作不可恢复。</p>
      </Modal>

      {/* Delete Repo Confirm Modal */}
      <Modal
        title="确认删除仓库"
        open={showDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
        onOk={doDeleteRepo}
        okText="删除"
        okType="danger"
        okButtonProps={{ loading: deletingRepo }}
        cancelText="取消"
      >
        <p>确定要删除仓库「{repo.name}」吗？该操作会删除所有关联配置和审查记录，且不可恢复。</p>
      </Modal>

      {/* Profile Detail Modal */}
      <Modal
        title={`Profile 详情: ${profileDetail?.name ?? ""}`}
        open={!!profileDetail}
        onCancel={() => setProfileDetail(null)}
        width={700}
        footer={<Button onClick={() => setProfileDetail(null)}>关闭</Button>}
      >
        {profileDetail && (
          <div>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="名称">{profileDetail.name}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={profileDetail.enabled ? "green" : "default"}>
                  {profileDetail.enabled ? "启用" : "停用"}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="描述" span={2}>
                {profileDetail.description || "-"}
              </Descriptions.Item>
              <Descriptions.Item label="严重度阈值">{profileDetail.severity_threshold}</Descriptions.Item>
              <Descriptions.Item label="创建时间">
                {dayjs(profileDetail.created_at).format("YYYY-MM-DD HH:mm")}
              </Descriptions.Item>
              <Descriptions.Item label="文件匹配模式" span={2}>
                <Text code>{profileDetail.file_patterns || "[]"}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="排除模式" span={2}>
                <Text code>{profileDetail.exclude_patterns || "[]"}</Text>
              </Descriptions.Item>
            </Descriptions>
            <Divider orientation="left" style={{ fontSize: 14 }}>审查 Prompt 模板</Divider>
            <div
              style={{
                maxHeight: 300,
                overflow: "auto",
                padding: 12,
                background: "#fafafa",
                borderRadius: 6,
                whiteSpace: "pre-wrap",
                fontFamily: "monospace",
                fontSize: 13,
                border: "1px solid #f0f0f0",
              }}
            >
              {profileDetail.prompt_template || "（未配置自定义 Prompt 模板，将使用系统默认模板）"}
            </div>
          </div>
        )}
      </Modal>

      {/* Dialogs */}
      <RepoFormDialog
        open={showEditRepo}
        editData={repo}
        onClose={() => setShowEditRepo(false)}
        onSuccess={() => {
          setShowEditRepo(false);
          invalidateAll();
          message.success("仓库更新成功");
        }}
      />
      <ProfileFormDialog
        open={showProfileDialog}
        repoId={repoId}
        editData={editingProfile}
        onClose={() => { setShowProfileDialog(false); setEditingProfile(null); }}
        onSuccess={() => {
          setShowProfileDialog(false);
          setEditingProfile(null);
          invalidateAll();
          message.success(editingProfile ? "Profile 已更新" : "Profile 创建成功");
        }}
      />
      <NotificationFormDialog
        open={showAddNotif}
        repoId={repoId}
        onClose={() => setShowAddNotif(false)}
        onSuccess={() => {
          setShowAddNotif(false);
          invalidateAll();
          message.success("通知配置成功");
        }}
      />
      <PollingConfigDialog
        open={showPolling}
        repoId={repoId}
        current={repo.polling_config}
        onClose={() => setShowPolling(false)}
        onSuccess={() => {
          setShowPolling(false);
          invalidateAll();
          message.success("轮询设置已更新");
        }}
      />
    </div>
  );
}
