import { Modal, Form, Input, Select } from "antd";
import { createNotification } from "../../api/client";

interface Props {
  open: boolean;
  repoId: number;
  onClose: () => void;
  onSuccess: () => void;
}

export default function NotificationFormDialog({
  open,
  repoId,
  onClose,
  onSuccess,
}: Props) {
  const [form] = Form.useForm();

  const handleOk = async () => {
    const values = await form.validateFields();
    await createNotification(repoId, values);
    onSuccess();
  };

  return (
    <Modal
      title="添加通知渠道"
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      okText="添加"
      cancelText="取消"
      destroyOnClose
    >
      <Form form={form} layout="vertical" initialValues={{ type: "feishu" }}>
        <Form.Item
          name="type"
          label="通知类型"
          rules={[{ required: true }]}
        >
          <Select
            options={[
              { value: "feishu", label: "飞书 (Feishu Webhook)" },
              { value: "webhook", label: "自定义 Webhook" },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="target"
          label="Webhook 地址"
          rules={[{ required: true, message: "请输入 Webhook URL" }]}
        >
          <Input placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx" />
        </Form.Item>
        <Form.Item name="target_name" label="渠道名称">
          <Input placeholder="例如: erp-oms 群聊" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
