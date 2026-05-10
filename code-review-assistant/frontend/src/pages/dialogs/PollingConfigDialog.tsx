import { useEffect } from "react";
import { Modal, Form, InputNumber, Switch, Descriptions } from "antd";
import dayjs from "dayjs";
import { updatePolling } from "../../api/client";
import type { PollingConfig } from "../../types";

interface Props {
  open: boolean;
  repoId: number;
  current: PollingConfig | null;
  onClose: () => void;
  onSuccess: () => void;
}

export default function PollingConfigDialog({
  open,
  repoId,
  current,
  onClose,
  onSuccess,
}: Props) {
  const [form] = Form.useForm();

  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        interval_minutes: current?.interval_minutes ?? 30,
        enabled: current?.enabled ?? false,
      });
    }
  }, [open, current, form]);

  const handleOk = async () => {
    const values = await form.validateFields();
    await updatePolling(repoId, values);
    onSuccess();
  };

  return (
    <Modal
      title="自动轮询设置"
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      okText="保存"
      cancelText="取消"
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item name="enabled" label="启用自动轮询" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item
          name="interval_minutes"
          label="轮询间隔 (分钟)"
          rules={[{ required: true, message: "请输入轮询间隔" }]}
        >
          <InputNumber min={1} max={1440} style={{ width: "100%" }} />
        </Form.Item>
      </Form>

      {current && (
        <Descriptions bordered size="small" column={1} style={{ marginTop: 16 }}>
          <Descriptions.Item label="上次轮询">
            {current.last_poll_at
              ? dayjs(current.last_poll_at).format("YYYY-MM-DD HH:mm:ss")
              : "从未执行"}
          </Descriptions.Item>
          <Descriptions.Item label="上次状态">
            {current.last_poll_status ?? "-"}
          </Descriptions.Item>
          <Descriptions.Item label="上次消息">
            {current.last_poll_message ?? "-"}
          </Descriptions.Item>
        </Descriptions>
      )}
    </Modal>
  );
}
