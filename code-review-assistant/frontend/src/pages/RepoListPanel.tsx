import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input, Button, List, Tag, Space, Typography, message } from "antd";
import { BranchesOutlined, PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { fetchRepos } from "../api/client";
import type { RepoListItem } from "../types";
import RepoFormDialog from "./dialogs/RepoFormDialog";

const { Text } = Typography;

interface Props {
  selectedId: number | null;
  onSelect: (id: number) => void;
  onOpenCrossTasks?: () => void;
  isAdmin?: boolean;
}

export default function RepoListPanel({
  selectedId,
  onSelect,
  onOpenCrossTasks,
  isAdmin = false,
}: Props) {
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const queryClient = useQueryClient();

  const { data: repos = [], isLoading } = useQuery({
    queryKey: ["repos"],
    queryFn: fetchRepos,
  });

  const filtered = repos.filter(
    (r) =>
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.local_path.toLowerCase().includes(search.toLowerCase())
  );

  const statusCounts = {
    total: repos.length,
    enabled: repos.filter((r) => r.enabled).length,
    polling: repos.filter((r) => r.polling_enabled).length,
  };

  return (
    <div style={{ padding: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <Text strong style={{ fontSize: 16 }}>
          仓库列表
        </Text>
        <Space size={8}>
          {onOpenCrossTasks && (
            <Button size="small" icon={<BranchesOutlined />} onClick={onOpenCrossTasks}>
              联审任务
            </Button>
          )}
          {isAdmin && (
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setShowCreate(true)}
            >
              新建
            </Button>
          )}
        </Space>
      </div>

      <Input
        placeholder="仓库名、路径、语言搜索"
        prefix={<SearchOutlined />}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 12 }}
        allowClear
      />

      <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
        共 {statusCounts.total} 个仓库 · 启用 {statusCounts.enabled} 个 ·
        轮询 {statusCounts.polling} 个 · 自动输出 {statusCounts.polling} 个
      </Text>

      <List
        loading={isLoading}
        dataSource={filtered}
        renderItem={(repo: RepoListItem) => (
          <List.Item
            onClick={() => onSelect(repo.id)}
            style={{
              cursor: "pointer",
              padding: "10px 12px",
              borderRadius: 6,
              marginBottom: 4,
              background: selectedId === repo.id ? "#f0f0ff" : undefined,
              border:
                selectedId === repo.id
                  ? "1px solid #d3adf7"
                  : "1px solid transparent",
            }}
          >
            <div style={{ width: "100%" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <Text strong>{repo.name}</Text>
                <Tag color={repo.enabled ? "purple" : "default"}>
                  {repo.enabled ? "启用中" : "已停用"}
                </Tag>
              </div>
              <div style={{ fontSize: 12, color: "#8c8c8c", marginTop: 2 }}>
                {repo.language || "Unknown"}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "#bfbfbf",
                  marginTop: 2,
                  wordBreak: "break-all",
                }}
              >
                {repo.local_path}
              </div>
              <div style={{ fontSize: 11, color: "#bfbfbf", marginTop: 2 }}>
                {repo.source_type} · 默认基线 {repo.baseline_branch}
              </div>
              <div style={{ marginTop: 4 }}>
                <Space size={4}>
                  <Tag style={{ fontSize: 11 }}>
                    {repo.profile_count} 个 profile
                  </Tag>
                  {repo.polling_enabled && (
                    <Tag color="blue" style={{ fontSize: 11 }}>
                      自动轮询 {repo.polling_interval}分钟
                    </Tag>
                  )}
                </Space>
              </div>
            </div>
          </List.Item>
        )}
      />

      <RepoFormDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={() => {
          setShowCreate(false);
          queryClient.invalidateQueries({ queryKey: ["repos"] });
          message.success("仓库创建成功");
        }}
      />
    </div>
  );
}
