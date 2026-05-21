# 03 Settings

## 结论

Settings 的主要后端端点存在，未发现主要按钮硬 404。但 tab 注册分散导致不可达/空白风险，`/settings/mcp` 与 Apps V2 的路由归属冲突，进入 Settings 时加载范围过大。

## 关键问题

- P1：Settings tab 注册不一致。`trash` / `audit-log` 类型和页面存在，但不在 URL 白名单、App 可见 tab、权限表中，直达会回退默认 tab。位置：`web/src/pages/settings/settings-constants.ts:190`、`web/src/App.tsx:2025`、`web/src/hooks/useAuth.ts:36`。
- P1：`extensions/mcp/skills/my-providers/my-channels` 在部分列表中存在，但 settings section 下拉和 render 分支不完整，直达可能空白。位置：`web/src/pages/settings/SettingsPage.tsx:146`。
- P1：`/settings/mcp` 和 `/settings/skills` 渲染 `AppsPageV2`，但 `AppsPageV2` 内部使用 `useNavigatedTab('apps')`，点击会跳到 `/apps/...`。位置：`SettingsPage.tsx:471`、`AppsPageV2.tsx:28`。
- P2：Prompt/Audit/Trash 多处原生控件、内联样式、`confirm/window.alert`，没有统一到共享控件和 native confirm。位置：`SettingsPromptTab.tsx:787`、`SettingsAuditLogTab.tsx:72`、`SettingsTrashTab.tsx:83`。
- P2：进入 Settings/Channels 初次会加载配置、渠道、清理、扩展、doctor 等全部数据。位置：`web/src/App.tsx:1993`。
- P2：任何 Settings tab 都会请求 subagent 配置和运行列表。位置：`useSettingsPageModel.tsx:392`、`:488`。
- P2：SSH delete/setDefault 和 Provider 部分动作错误处理弱，失败可能表现为刷新成功。位置：`SettingsSshKeysTab.tsx:64`、`:76`、`useProviderActions.ts:173`。

## 优化建议

1. 建立单一 `SETTINGS_TAB_REGISTRY`，驱动类型、URL 白名单、权限、下拉项和 render 分支。
2. 让 Apps V2 支持 route base 参数，或 Settings 回退使用已有 `SettingsMcpTab` / `SettingsSkillsTab`。
3. Settings 按 tab 懒加载：subagent、extensions、diagnostics、prompt preview、provider shares 都延迟到实际 tab。
4. 用统一 `requestJson`/toast/confirm 替换裸 fetch 错误吞掉和 `window.confirm/window.alert`。
5. 样式上减少 `.settings-section/.settings-subsection` 的嵌套卡片层级，贴近连续 pale-blue canvas 基线。

