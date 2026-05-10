import { useEffect } from "react";
import { Modal, Form, Input, Select, Switch } from "antd";
import { createRepo, updateRepo } from "../../api/client";
import type { RepoDetail } from "../../types";

interface Props {
  open: boolean;
  editData?: RepoDetail;
  onClose: () => void;
  onSuccess: () => void;
}

export default function RepoFormDialog({
  open,
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
        language: editData.language,
        local_path: editData.local_path,
        source_type: editData.source_type,
        baseline_branch: editData.baseline_branch,
        enabled: editData.enabled,
      });
    } else if (open) {
      form.resetFields();
    }
  }, [open, editData, form]);

  const handleOk = async () => {
    const values = await form.validateFields();
    if (isEdit) {
      await updateRepo(editData!.id, values);
    } else {
      await createRepo(values);
    }
    onSuccess();
  };

  return (
    <Modal
      title={isEdit ? "编辑仓库" : "新建仓库"}
      open={open}
      onCancel={onClose}
      onOk={handleOk}
      okText="保存"
      cancelText="取消"
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          source_type: "gitlab",
          baseline_branch: "master",
          enabled: true,
        }}
      >
        <Form.Item
          name="name"
          label="仓库名称"
          rules={[{ required: true, message: "请输入仓库名称" }]}
        >
          <Input placeholder="例如: erp-oms" />
        </Form.Item>
        <Form.Item
          name="local_path"
          label="本地路径"
          rules={[{ required: true, message: "请输入本地 Git 仓库路径" }]}
        >
          <Input placeholder="例如: D:\open_source\erp-oms" />
        </Form.Item>
        <Form.Item name="language" label="语言">
          <Select
            placeholder="选择语言"
            allowClear
            options={[
              { value: "Java", label: "Java" },
              { value: "Python", label: "Python" },
              { value: "TypeScript", label: "TypeScript" },
              { value: "JavaScript", label: "JavaScript" },
              { value: "Go", label: "Go" },
              { value: "Rust", label: "Rust" },
              { value: "C#", label: "C#" },
              { value: "Other", label: "Other" },
            ]}
          />
        </Form.Item>
        <Form.Item name="source_type" label="代码源类型">
          <Select
            options={[
              { value: "gitlab", label: "GitLab" },
              { value: "github", label: "GitHub" },
              { value: "gitee", label: "Gitee" },
              { value: "local", label: "本地" },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="baseline_branch"
          label="基线分支"
          tooltip="代码审查时用来做 diff 对比的基准分支"
        >
          <Input placeholder="master" />
        </Form.Item>
        {isEdit && (
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
