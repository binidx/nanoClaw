import { Card, Tag } from "antd";
import type { ReactNode } from "react";

interface Props {
  title: string;
  description: string;
  status: "connected" | "configured" | "enabled" | "disabled" | "none";
  icon?: ReactNode;
  children?: ReactNode;
}

const statusConfig: Record<string, { color: string; text: string }> = {
  connected: { color: "green", text: "已连接" },
  configured: { color: "blue", text: "已配置" },
  enabled: { color: "purple", text: "已启用" },
  disabled: { color: "default", text: "未启用" },
  none: { color: "default", text: "未配置" },
};

export default function StatusCard({
  title,
  description,
  status,
  icon,
  children,
}: Props) {
  const cfg = statusConfig[status] || statusConfig.none;

  return (
    <Card
      size="small"
      style={{
        borderRadius: 8,
        flex: 1,
        minWidth: 180,
      }}
      styles={{ body: { padding: "12px 16px" } }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 14 }}>
          {icon && <span style={{ marginRight: 6 }}>{icon}</span>}
          {title}
        </span>
        <Tag color={cfg.color}>{cfg.text}</Tag>
      </div>
      <div style={{ color: "#8c8c8c", fontSize: 12, lineHeight: 1.6 }}>
        {description}
      </div>
      {children}
    </Card>
  );
}
