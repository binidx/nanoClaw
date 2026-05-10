# Live2D 聊天伴侣功能设计文档

## 概述

为 NanoClaw 聊天界面新增 Live2D 侧边栏伴侣角色功能。用户可以上传和管理 Live2D 模型，AI 回复时自动触发情感驱动的表情和动作切换。

## 核心决策

| 维度 | 决策 |
|------|------|
| 定位 | 聊天界面侧边栏/浮窗伴侣角色 |
| 资源模型 | 公共共享池 + 用户私有上传，可配置可见性 |
| 动作触发 | 混合模式：待机空闲动画 + 回复时情感驱动动作 |
| 配置开关 | 全局管理员开关 + 用户个人偏好 |
| 情感分析 | 回复后轻量级 LLM 分类，可配置辅助模型 |
| 渲染引擎 | pixi-live2d-display (PixiJS, 支持 Cubism 2/3/4) |
| 模型存储 | 数据库 BLOB + 本地文件缓存 |

## 数据表

- `live2d_models` - 模型主表 (id, name, user_id, visibility, format, model_data BLOB, thumbnail, file_size, entry_file)
- `live2d_emotion_mappings` - 情感到动作映射 (model_id, emotion, motion_group, expression_name, priority)
- `live2d_user_preferences` - 用户偏好 (user_id, enabled, selected_model_id, position, panel_width, opacity, emotion_provider_id)

全局开关使用 `config` 表: `LIVE2D_ENABLED`, `LIVE2D_EMOTION_ENABLED`。

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/live2d/config` | GET | 全局配置 + 用户偏好 |
| `/api/live2d/models` | GET/POST | 模型列表 / 上传 |
| `/api/live2d/models/:id` | DELETE/PATCH | 删除 / 更新模型 |
| `/api/live2d/models/:id/files/*` | GET | 模型文件服务 |
| `/api/live2d/models/:id/thumbnail` | GET | 缩略图 |
| `/api/live2d/models/:id/emotions` | GET/PUT | 情感映射 CRUD |
| `/api/live2d/preferences` | GET/PUT | 用户偏好 |
| `/api/live2d/emotion-providers` | GET | 可用情感分析模型列表 |

## WebSocket 事件

`live2d_emotion` 事件在 AI 回复完成后异步推送，包含 `emotion` 标签和 `turnId`。

## 前端组件

- `Live2DPanel` - 主容器 (PixiJS canvas + 控制栏)
- `Live2DSettingsTab` - 设置面板标签页 (模型管理 + 偏好 + 情感模型下拉框)

## 文件变更清单

### 后端新增
- `src/live2d-service.ts` - 模型 CRUD, ZIP 缓存管理
- `src/emotion-service.ts` - 情感分析, LLM 调用, 关键词回退
- `src/routes/live2d-routes.ts` - REST API

### 后端修改
- `src/db.ts` - 3 张新表 (SQLite/MySQL/PostgreSQL)
- `src/config-store.ts` - LIVE2D_ENABLED, LIVE2D_EMOTION_ENABLED
- `src/web-server.ts` - 路由注册
- `src/channels/web.ts` - notifyLive2DEmotion 方法
- `src/realtime-events.ts` - live2d_emotion 事件类型
- `src/index.ts` - 回复后异步情感分析触发

### 前端新增
- `web/src/components/live2d/Live2DPanel.tsx`
- `web/src/components/live2d/Live2DSettingsTab.tsx`
- `web/src/components/live2d/live2d.css`

### 前端修改
- `web/src/app-types.ts` - Live2D 类型定义, SettingsTab 扩展
- `web/src/App.tsx` - Live2D 状态, WS 事件处理, 面板渲染
- `web/src/pages/SettingsPage.tsx` - Live2D 设置标签页
