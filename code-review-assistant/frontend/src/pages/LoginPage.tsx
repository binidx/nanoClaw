import { useState } from "react";
import { Alert, Button, Card, Form, Input, Typography, Space } from "antd";
import { LockOutlined, UserOutlined, KeyOutlined } from "@ant-design/icons";
import { login } from "../api/client";
import { useAuth, type UserRole } from "../contexts/AuthContext";

const { Title, Text } = Typography;

export default function LoginPage() {
  const { setAuth } = useAuth();
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const onFinish = async (values: { api_key: string; username: string; password: string }) => {
    const apiKey = values.api_key?.trim();
    if (!apiKey) {
      setErrorMsg("请输入 API Key");
      return;
    }

    setLoading(true);
    setErrorMsg("");
    setSuccessMsg("");
    try {
      const resp = await login({
        api_key: apiKey,
        username: values.username?.trim() || "",
        password: values.password || "",
      });
      setSuccessMsg(resp.message || "登录成功，正在进入系统...");
      setTimeout(() => setAuth(resp.role as UserRole, apiKey), 600);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      setErrorMsg(typeof detail === "string" ? detail : "登录失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
      }}
    >
      <Card
        style={{
          width: 420,
          borderRadius: 12,
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.18)",
        }}
        styles={{ body: { padding: "40px 36px 28px" } }}
      >
        <Space direction="vertical" size={4} style={{ width: "100%", marginBottom: 28 }}>
          <Title level={3} style={{ margin: 0, textAlign: "center" }}>
            代码审查系统
          </Title>
          <Text type="secondary" style={{ display: "block", textAlign: "center", fontSize: 13 }}>
            请输入 API Key 以继续，管理员可选填账号密码
          </Text>
        </Space>

        {errorMsg && (
          <Alert
            type="error"
            message={errorMsg}
            showIcon
            closable
            onClose={() => setErrorMsg("")}
            style={{ marginBottom: 16 }}
          />
        )}
        {successMsg && (
          <Alert type="success" message={successMsg} showIcon style={{ marginBottom: 16 }} />
        )}

        <Form layout="vertical" onFinish={onFinish} autoComplete="off" requiredMark={false}>
          <Form.Item
            label="API Key"
            name="api_key"
            rules={[{ required: true, message: "API Key 为必填项" }]}
          >
            <Input.Password
              prefix={<KeyOutlined />}
              placeholder="支持 Cursor Key（crsr_）或 Anthropic Key"
              size="large"
            />
          </Form.Item>

          <Form.Item label="管理员账号（选填）" name="username">
            <Input prefix={<UserOutlined />} placeholder="不填则以访客身份进入" size="large" />
          </Form.Item>

          <Form.Item label="管理员密码（选填）" name="password">
            <Input.Password prefix={<LockOutlined />} placeholder="不填则以访客身份进入" size="large" />
          </Form.Item>

          <Form.Item style={{ marginBottom: 12, marginTop: 8 }}>
            <Button type="primary" htmlType="submit" block size="large" loading={loading}>
              {loading ? "验证中..." : "进入系统"}
            </Button>
          </Form.Item>

          <Text type="secondary" style={{ display: "block", textAlign: "center", fontSize: 12 }}>
            crsr_ 开头使用 Cursor CLI，其他 Key 使用 Claude Code CLI
          </Text>
        </Form>
      </Card>
    </div>
  );
}
