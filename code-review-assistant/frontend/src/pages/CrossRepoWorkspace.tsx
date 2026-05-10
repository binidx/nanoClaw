import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Collapse,
  Descriptions,
  Divider,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from "antd";
import {
  BranchesOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  DownloadOutlined,
  ReloadOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "../styles/review-markdown.css";
import {
  fetchCrossRepoProfileOptions,
  fetchCrossRepoQueueStatus,
  fetchCrossRepoReview,
  fetchCrossRepoRuns,
  searchCrossRepoBranchHints,
  downloadCrossRepoReport,
  downloadReviewReport,
  triggerCrossRepoReview,
} from "../api/client";
import type {
  CrossRepoQueueStatus,
  CrossRepoProfileOption,
  CrossRepoReviewDetail,
  CrossRepoReviewRun,
  ReviewProgressEvent,
  ReviewResult,
} from "../types";

const { Title, Text } = Typography;

function parseProgressEvents(progressText: string): ReviewProgressEvent[] {
  if (!progressText) return [];
  try {
    const parsed = JSON.parse(progressText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function extractMatchedRepos(progressText: string): string[] {
  const events = parseProgressEvents(progressText);
  const event = events.find((e) => e.stage === "matched_repos" && e.message);
  if (!event?.message) return [];
  return event.message
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export default function CrossRepoWorkspace() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [showTrigger, setShowTrigger] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [profileIds, setProfileIds] = useState<number[]>([]);
  const [lastProfileIds, setLastProfileIds] = useState<number[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [selectedChild, setSelectedChild] = useState<ReviewResult | null>(null);

  const emptyPage = { items: [], total: 0, page: 1, page_size: 10 };
  const { data: runsData = emptyPage, isLoading } = useQuery({
    queryKey: ["cross-runs", page, pageSize],
    queryFn: () => fetchCrossRepoRuns(page, pageSize),
    refetchInterval: (query) => {
      const items = query.state.data?.items || [];
      return items.some((x) => x.status === "reviewing") ? 3000 : false;
    },
  });

  const { data: detail } = useQuery({
    queryKey: ["cross-review", selectedRunId],
    queryFn: () => fetchCrossRepoReview(selectedRunId as number),
    enabled: !!selectedRunId,
    refetchInterval: (query) => {
      const st = query.state.data?.run?.status;
      return st === "reviewing" ? 2500 : false;
    },
  });

  const { data: queue } = useQuery({
    queryKey: ["cross-review-queue", selectedRunId],
    queryFn: () => fetchCrossRepoQueueStatus(selectedRunId as number),
    enabled: !!selectedRunId,
    refetchInterval: (query) => {
      const st = query.state.data?.status;
      return st === "reviewing" ? 2500 : false;
    },
  });
  const { data: branchHints = [] } = useQuery({
    queryKey: ["cross-branch-hints", branchName],
    queryFn: () => searchCrossRepoBranchHints(branchName, 30),
    enabled: showTrigger,
  });
  const { data: profileOptions = [] } = useQuery({
    queryKey: ["cross-profile-options"],
    queryFn: fetchCrossRepoProfileOptions,
    enabled: showTrigger,
  });
  const dedupedBranchHints = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of branchHints || []) {
      const v = String(name || "").trim();
      const key = v;
      if (!v || seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  }, [branchHints]);

  const handleTrigger = async () => {
    const branch = branchName.trim();
    if (!branch) {
      message.warning("请输入分支名");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await triggerCrossRepoReview({
        branch_name: branch,
        profile_ids: profileIds.length > 0 ? profileIds : undefined,
      });
      message.success("联审任务已创建");
      setLastProfileIds(profileIds);
      setShowTrigger(false);
      setSelectedRunId(resp.run.id);
      setPage(1);
      queryClient.invalidateQueries({ queryKey: ["cross-runs"] });
    } catch (err: any) {
      message.error(err?.response?.data?.detail || "触发联审失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownloadCrossReport = async (runId: number) => {
    try {
      await downloadCrossRepoReport(runId);
    } catch (err: any) {
      message.error(err?.message || "下载联审总报告失败");
    }
  };

  const handleDownloadChildReport = async (reviewId: number) => {
    try {
      await downloadReviewReport(reviewId);
    } catch (err: any) {
      message.error(err?.message || "下载分仓审查报告失败");
    }
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <Tag color="purple" style={{ fontSize: 11, marginBottom: 8 }}>
            CROSS-REPO REVIEW
          </Tag>
          <Title level={4} style={{ margin: 0 }}>
            联审任务列表
          </Title>
          <Text type="secondary">统一查看跨仓库联审任务，并可进入任务详情。</Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => queryClient.invalidateQueries({ queryKey: ["cross-runs"] })}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<BranchesOutlined />}
            onClick={() => {
              setProfileIds(lastProfileIds);
              setShowTrigger(true);
            }}
          >
            新建联审任务
          </Button>
        </Space>
      </div>

      <Table<CrossRepoReviewRun>
        loading={isLoading}
        dataSource={runsData.items}
        rowKey="id"
        onRow={(record) => ({
          onClick: () => setSelectedRunId(record.id),
          style: { cursor: "pointer" },
        })}
        pagination={{
          current: page,
          pageSize,
          total: runsData.total,
          showSizeChanger: true,
          pageSizeOptions: ["10", "20", "50"],
          showTotal: (total) => `共 ${total} 条`,
          onChange: (nextPage, nextPageSize) => {
            setPage(nextPage);
            setPageSize(nextPageSize);
          },
        }}
        columns={[
          {
            title: "任务ID",
            dataIndex: "id",
            width: 90,
            render: (v: number) => <Text code>#{v}</Text>,
          },
          { title: "目标分支", dataIndex: "branch_name", width: 260 },
          {
            title: "状态",
            dataIndex: "status",
            width: 120,
            render: (v: string) => (
              <Tag color={v === "passed" ? "green" : v === "reviewing" ? "processing" : v === "failed" ? "red" : "volcano"}>
                {v}
              </Tag>
            ),
          },
          {
            title: "匹配仓库",
            key: "matched_repos",
            width: 260,
            render: (_: unknown, record: CrossRepoReviewRun) => {
              const names = extractMatchedRepos(record.review_progress);
              if (names.length === 0) return "-";
              return (
                <Text>
                  {names.slice(0, 3).join(", ")}
                  {names.length > 3 ? ` 等 ${names.length} 个` : ""}
                </Text>
              );
            },
          },
          {
            title: "创建时间",
            dataIndex: "created_at",
            width: 180,
            render: (v: string) => dayjs(v).format("YYYY-MM-DD HH:mm:ss"),
          },
        ]}
      />

      <Modal
        title="创建跨仓库联审"
        open={showTrigger}
        onCancel={() => setShowTrigger(false)}
        onOk={handleTrigger}
        okText="开始联审"
        confirmLoading={submitting}
      >
        <Text type="secondary">输入分支名后，系统将在所有仓库中查找同名分支并统一触发。</Text>
        <Select
          showSearch
          allowClear
          style={{ marginTop: 10, width: "100%" }}
          value={branchName}
          options={dedupedBranchHints.map((x) => ({ value: x }))}
          placeholder="例如：feature/xxx"
          onSearch={setBranchName}
          onChange={(v) => setBranchName(v || "")}
          filterOption={false}
        />
        <Select
          mode="multiple"
          allowClear
          style={{ marginTop: 10, width: "100%" }}
          placeholder="可选：选择本次联审要带入的 Profile（默认不额外带入）"
          value={profileIds}
          onChange={(vals) => setProfileIds((vals as number[]) || [])}
          options={(profileOptions as CrossRepoProfileOption[]).map((p) => ({
            value: p.id,
            label: `${p.repo_name} / ${p.name}`,
          }))}
        />
      </Modal>

      <Modal
        title={`联审任务详情 #${detail?.run.id ?? selectedRunId ?? ""}`}
        open={!!selectedRunId}
        onCancel={() => setSelectedRunId(null)}
        width={980}
        footer={
          <Space>
            {detail?.run?.status !== "reviewing" && detail?.run?.id && (
              <Button
                icon={<DownloadOutlined />}
                onClick={() => handleDownloadCrossReport(detail.run.id)}
              >
                下载联审总报告
              </Button>
            )}
            <Button onClick={() => setSelectedRunId(null)}>关闭</Button>
          </Space>
        }
      >
        {!detail ? (
          <div style={{ textAlign: "center", padding: "40px 0" }}>
            <Spin />
          </div>
        ) : (
          <CrossRunDetailContent
            detail={detail}
            queue={queue}
            onViewChild={(item) => setSelectedChild(item)}
            onDownloadChild={(id) => handleDownloadChildReport(id)}
          />
        )}
      </Modal>

      <Modal
        title={`分仓审查详情 #${selectedChild?.id ?? ""}`}
        open={!!selectedChild}
        onCancel={() => setSelectedChild(null)}
        width={900}
        footer={
          selectedChild ? (
            <Space>
              {selectedChild.status !== "reviewing" && (
                <Button
                  icon={<DownloadOutlined />}
                  onClick={() => handleDownloadChildReport(selectedChild.id)}
                >
                  下载分仓报告
                </Button>
              )}
              <Button onClick={() => setSelectedChild(null)}>关闭</Button>
            </Space>
          ) : null
        }
      >
        {selectedChild && (
          <div className="review-markdown" style={{ maxHeight: 520, overflow: "auto", background: "#fafafa", borderRadius: 6, padding: "10px 12px" }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {selectedChild.detail || "暂无分仓审查详情"}
            </ReactMarkdown>
          </div>
        )}
      </Modal>
    </div>
  );
}

function CrossRunDetailContent({
  detail,
  queue,
  onViewChild,
  onDownloadChild,
}: {
  detail: CrossRepoReviewDetail;
  queue?: CrossRepoQueueStatus;
  onViewChild: (item: ReviewResult) => void;
  onDownloadChild: (reviewId: number) => void;
}) {
  const reviewProgress = useMemo<ReviewProgressEvent[]>(() => {
    return parseProgressEvents(detail.run.review_progress);
  }, [detail.run.review_progress]);
  const matchedRepos = useMemo(() => extractMatchedRepos(detail.run.review_progress), [detail.run.review_progress]);

  const systemProgress = useMemo<ReviewProgressEvent[]>(
    () =>
      reviewProgress.filter(
        (e) =>
          e.stage !== "ai_thought_summary" &&
          e.stage !== "ai_thought_step" &&
          e.stage !== "tool_call" &&
          e.stage !== "llm_stream_chunk" &&
          e.stage !== "heartbeat" &&
          e.stage !== "matched_repos"
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
    return detail.run.summary || "暂无思考摘要";
  }, [reviewProgress, detail.run.summary]);

  const completionState = useMemo(() => {
    if (detail.run.status === "reviewing") return "进行中";
    if (detail.run.status === "passed") return "已完成（通过）";
    if (detail.run.status === "failed") return "已完成（不通过）";
    if (detail.run.status === "error") return "已完成（错误）";
    return detail.run.status;
  }, [detail.run.status]);

  const aiProcessItems = useMemo(() => {
    const items: Array<{
      key: string;
      kind: "thought" | "tool" | "status";
      title: string;
      subtitle: string;
      content: string;
      time?: string;
      done: boolean;
    }> = [];
    reviewProgress.forEach((e, idx) => {
      if (!(e.stage === "ai_thought_summary" || e.stage === "ai_thought_step" || e.stage === "tool_call")) {
        return;
      }
      const meta =
        e.stage === "tool_call"
          ? { kind: "tool" as const, title: "工具", subtitle: "调用工具读取或检索跨仓库信息。" }
          : e.stage === "ai_thought_summary"
          ? { kind: "thought" as const, title: "规划下一步", subtitle: "模型对联审路径的总体思路。" }
          : { kind: "thought" as const, title: "思考", subtitle: "模型在联审中的推理步骤。" };

      items.push({
        key: `${e.stage}-${idx}-${e.time || ""}`,
        kind: meta.kind,
        title: meta.title,
        subtitle: meta.subtitle,
        content: e.message,
        time: e.time,
        done: detail.run.status !== "reviewing" || idx < reviewProgress.length - 1,
      });
    });

    if (items.length === 0 && aiThoughtSummary) {
      items.push({
        key: "fallback-thought",
        kind: "thought",
        title: "规划下一步",
        subtitle: "模型给出的简要思路。",
        content: aiThoughtSummary,
        done: detail.run.status !== "reviewing",
      });
    }
    return items;
  }, [reviewProgress, aiThoughtSummary, detail.run.status]);

  const queueHint = useMemo(() => {
    if (!queue) return "";
    if (queue.active_total > 0) return `正在执行（并发 ${queue.active_total}/${queue.max_concurrency}）`;
    if (queue.queued_total > 0) return `排队中（队列总长 ${queue.queued_total}）`;
    if (detail.run.status === "reviewing") return "任务状态同步中...";
    return "";
  }, [queue, detail.run.status]);

  return (
    <>
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="目标分支">{detail.run.branch_name}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={detail.run.status === "passed" ? "green" : detail.run.status === "reviewing" ? "processing" : "volcano"}>
            {detail.run.status}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="匹配仓库" span={2}>
          {matchedRepos.length > 0 ? (
            <Space wrap>
              {matchedRepos.map((name) => (
                <Tag key={name}>{name}</Tag>
              ))}
            </Space>
          ) : (
            "-"
          )}
        </Descriptions.Item>
      </Descriptions>

      {queue && detail.run.status === "reviewing" && (
        <div style={{ marginTop: 10 }}>
          <Tag color={queue.status === "reviewing" ? "processing" : "default"}>
            队列：排队 {queue.queued_total} / 执行中 {queue.active_total} / 已完成 {queue.done_total} / 总数 {queue.total_children}
          </Tag>
        </div>
      )}

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
                      {item.kind === "tool" ? <Text code>{item.content}</Text> : <Text>{item.content}</Text>}
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
        <Tag color={detail.run.status === "passed" ? "green" : detail.run.status === "reviewing" ? "processing" : detail.run.status === "failed" ? "red" : "volcano"}>
          {completionState}
        </Tag>
        {detail.run.completed_at && (
          <Text type="secondary">
            完成时间：{dayjs(detail.run.completed_at).format("YYYY-MM-DD HH:mm:ss")}
          </Text>
        )}
      </Space>

      <Divider orientation="left" style={{ fontSize: 14, marginTop: 16 }}>
        审查进度
      </Divider>
      {detail.run.status === "reviewing" && heartbeatEvent && (
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
      {detail.run.status === "reviewing" && (
        <div style={{ marginBottom: 10 }}>
          <Tag color={queue?.active_total ? "processing" : "gold"}>
            {queueHint || "排队信息获取中..."}
          </Tag>
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
                <div style={{ fontWeight: 500 }}>{e.message}</div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {dayjs(e.time).format("YYYY-MM-DD HH:mm:ss")} · {e.stage}
                </Text>
              </div>
            ),
          }))}
        />
      )}

      <Divider orientation="left">联审总报告</Divider>
      <div className="review-markdown" style={{ maxHeight: 360, overflow: "auto", background: "#fafafa", borderRadius: 6, padding: "10px 12px" }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {detail.run.detail || "暂无联审报告"}
        </ReactMarkdown>
      </div>

      <Divider orientation="left" style={{ marginTop: 16 }}>分仓审查报告</Divider>
      <Table<ReviewResult>
        dataSource={detail.children || []}
        rowKey="id"
        size="small"
        pagination={false}
        locale={{ emptyText: "暂无分仓审查记录" }}
        columns={[
          {
            title: "记录ID",
            dataIndex: "id",
            width: 100,
            render: (v: number) => <Text code>#{v}</Text>,
          },
          {
            title: "仓库ID",
            dataIndex: "repo_id",
            width: 90,
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
            render: (v: string) => (
              <Tag color={v === "passed" ? "green" : v === "reviewing" ? "processing" : v === "failed" ? "red" : "volcano"}>
                {v}
              </Tag>
            ),
          },
          {
            title: "问题数",
            dataIndex: "findings_count",
            width: 90,
          },
          {
            title: "操作",
            width: 170,
            render: (_: unknown, record: ReviewResult) => (
              <Space size={4}>
                <Button type="link" size="small" onClick={() => onViewChild(record)}>
                  查看
                </Button>
                {record.status !== "reviewing" && (
                  <Button
                    type="link"
                    size="small"
                    icon={<DownloadOutlined />}
                    onClick={() => onDownloadChild(record.id)}
                  >
                    报告
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
    </>
  );
}
