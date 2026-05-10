import { Badge } from "antd";

interface Props {
  status: "success" | "error" | "default" | "processing" | "warning";
  text: string;
}

export default function StatusBadge({ status, text }: Props) {
  return <Badge status={status} text={text} />;
}
