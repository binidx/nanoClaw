import { useEffect, useState } from "react";
import { Layout, Button, Space, Tag } from "antd";
import { LogoutOutlined } from "@ant-design/icons";
import { useAuth } from "./contexts/AuthContext";
import LoginPage from "./pages/LoginPage";
import RepoListPanel from "./pages/RepoListPanel";
import RepoWorkspace from "./pages/RepoWorkspace";
import CrossRepoWorkspace from "./pages/CrossRepoWorkspace";

const { Sider, Content } = Layout;
const WS_MODE_KEY = "code_review_workspace_mode";
const WS_REPO_KEY = "code_review_workspace_repo_id";

function loadWorkspaceMode(): "repo" | "cross" {
  const raw = localStorage.getItem(WS_MODE_KEY);
  return raw === "cross" ? "cross" : "repo";
}

function loadSelectedRepoId(): number | null {
  const raw = localStorage.getItem(WS_REPO_KEY);
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : null;
}

export default function App() {
  const { authenticated, role, isAdmin, logout } = useAuth();
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(loadSelectedRepoId);
  const [workspaceMode, setWorkspaceMode] = useState<"repo" | "cross">(loadWorkspaceMode);

  useEffect(() => {
    localStorage.setItem(WS_MODE_KEY, workspaceMode);
  }, [workspaceMode]);

  useEffect(() => {
    if (selectedRepoId && selectedRepoId > 0) {
      localStorage.setItem(WS_REPO_KEY, String(selectedRepoId));
    } else {
      localStorage.removeItem(WS_REPO_KEY);
    }
  }, [selectedRepoId]);

  if (!authenticated) {
    return <LoginPage />;
  }

  return (
    <Layout style={{ minHeight: "100vh", background: "#f0f2f5" }}>
      <div
        style={{
          padding: "20px 24px 8px",
          background: "#fff",
          borderBottom: "1px solid #f0f0f0",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>代码审查</h2>
          <p style={{ margin: "4px 0 0", color: "#8c8c8c", fontSize: 13 }}>
            独立管理 Repo Review 的仓库、Profile 和审查运行。
          </p>
        </div>
        <Space>
          <Tag color={isAdmin ? "purple" : "blue"}>{isAdmin ? "管理员" : "访客"}</Tag>
          <Button size="small" icon={<LogoutOutlined />} onClick={logout}>
            退出
          </Button>
        </Space>
      </div>
      <Layout style={{ background: "#f0f2f5" }}>
        <Sider
          width={320}
          style={{
            background: "#fff",
            margin: "16px 0 16px 16px",
            borderRadius: 8,
            overflow: "auto",
          }}
        >
          <RepoListPanel
            selectedId={workspaceMode === "repo" ? selectedRepoId : null}
            onSelect={(id) => {
              setSelectedRepoId(id);
              setWorkspaceMode("repo");
            }}
            onOpenCrossTasks={() => {
              setWorkspaceMode("cross");
              setSelectedRepoId(null);
            }}
            isAdmin={isAdmin}
          />
        </Sider>
        <Content
          style={{
            margin: "16px",
            background: "#fff",
            borderRadius: 8,
            overflow: "auto",
          }}
        >
          {workspaceMode === "cross" ? (
            <CrossRepoWorkspace />
          ) : selectedRepoId ? (
            <RepoWorkspace
              repoId={selectedRepoId}
              role={role}
              onDeleted={() => {
                setSelectedRepoId(null);
                setWorkspaceMode("repo");
              }}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "#bfbfbf",
                fontSize: 16,
              }}
            >
              请从左侧选择一个仓库
            </div>
          )}
        </Content>
      </Layout>
    </Layout>
  );
}
