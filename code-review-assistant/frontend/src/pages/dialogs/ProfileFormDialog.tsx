import { useEffect } from "react";
import { Modal, Form, Input, Select } from "antd";
import { createProfile, updateProfile } from "../../api/client";
import type { ReviewProfile } from "../../types";

const { TextArea } = Input;

interface Props {
  open: boolean;
  repoId: number;
  editData?: ReviewProfile | null;
  onClose: () => void;
  onSuccess: () => void;
}

export default function ProfileFormDialog({
  open,
  repoId,
  editData,
  onClose,
  onSuccess,
}: Props) {
  const [form] = Form.useForm();
  const isEdit = !!editData;

  useEffect(() => {
    if (open && editData) {
      form.setFieldsValue({
        name: editData.name,
        description: editData.description || "",
        prompt_template: editData.prompt_template || "",
        file_patterns: editData.file_patterns || "",
        exclude_patterns: editData.exclude_patterns || "",
        severity_threshold: editData.severity_threshold || "P2",
      });
    } else if (open) {
      form.resetFields();
    }
  }, [open, editData, form]);

  const handleOk = async () => {
    const values = await form.validateFields();
    if (isEdit) {
      await updateProfile(editData.id, values);
    } else {
      await createProfile(repoId, values);
    }
    onSuccess();
  };

  return (
    <Modal
      title={isEdit ? "编辑审查 Profile" : "创建审查 Profile"}
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      okText={isEdit ? "保存" : "创建"}
      cancelText="取消"
      destroyOnClose
      width={640}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ severity_threshold: "P2" }}
      >
        <Form.Item
          name="name"
          label="Profile 名称"
          rules={[{ required: true, message: "请输入名称" }]}
        >
          <Input placeholder="例如: 安全审查、代码质量检查" />
        </Form.Item>
        <Form.Item name="description" label="描述">
          <Input placeholder="Profile 用途简述" />
        </Form.Item>
        <Form.Item name="prompt_template" label="审查提示模板">
          <TextArea
            rows={6}
            placeholder={"自定义审查指令，留空则使用默认审查模板。\n例如：重点关注SQL注入、XSS等安全问题，以及性能瓶颈。"}
          />
        </Form.Item>
        <Form.Item name="file_patterns" label="文件匹配 (JSON 数组)">
          <Input placeholder='例如: ["*.java", "*.py"]，留空表示所有文件' />
        </Form.Item>
        <Form.Item name="exclude_patterns" label="排除文件 (JSON 数组)">
          <Input placeholder='例如: ["*.test.java", "*.md"]' />
        </Form.Item>
        <Form.Item name="severity_threshold" label="严重度阈值">
          <Select
            options={[
              { value: "P0", label: "P0 - 仅严重问题" },
              { value: "P1", label: "P1 - 严重 + 重要" },
              { value: "P2", label: "P2 - 中等及以上" },
              { value: "P3", label: "P3 - 所有问题" },
            ]}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
