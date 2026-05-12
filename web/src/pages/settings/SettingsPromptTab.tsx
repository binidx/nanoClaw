import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type PromptDefinition = {
  key: string;
  featureScope: string;
  title: string;
  description: string;
  promptKind: string;
  layer?: string;
  mutability?: string;
  defaultTemplate: string;
  variables: string[];
};

type PromptConfigRecord = {
  id: string;
  scope_kind: 'system' | 'user';
  owner_user_id: string;
  prompt_key: string;
  feature_scope: string;
  template_text: string;
  notes: string | null;
  updated_at: string;
};

type PromptResolution = {
  promptKey: string;
  featureScope: string;
  source: 'builtin' | 'system_default' | 'user_override';
  ownerUserId: string;
  configured: boolean;
};

type PromptLookup = {
  text: string;
  resolution: PromptResolution;
  config: PromptConfigRecord | null;
};

type PromptPreview = {
  featureScope: string;
  promptKey?: string | null;
  targetUserId?: string | null;
  chatJid?: string | null;
  systemPromptText?: string | null;
  userPromptText: string;
  providerInputText?: string | null;
  cacheFingerprint?: string | null;
  stablePrefixFingerprint?: string | null;
  segments: Array<{
    id: string;
    label: string;
    promptKey?: string;
    layer?: string;
    source: string;
    content: string;
  }>;
  resolution: PromptResolution[];
  metadata?: Record<string, unknown>;
};

type PromptTraceRecord = {
  id: string;
  trace_kind: string;
  prompt_key: string | null;
  feature_scope: string;
  target_user_id: string;
  chat_jid: string | null;
  provider: string | null;
  model: string | null;
  system_prompt_text: string | null;
  user_prompt_text: string;
  provider_input_text: string | null;
  segments_json: string;
  resolution_json: string;
  metadata_json: string | null;
  created_at: string;
};

type PromptUser = {
  id: string;
  username: string;
  status: string;
};

type PromptConversation = {
  jid: string;
  name: string;
  custom_title?: string | null;
  display_name?: string;
  channel?: string;
};

type RepoReviewRunSummary = {
  id: string;
  repositoryId: string;
  branch?: string;
  actor?: string;
  summary?: string;
  status?: string;
  overall?: string;
  createdAt?: string;
};

type PromptPreviewScenario = {
  id: string;
  title: string;
  description: string;
  featureScope: string;
  promptKey?: string;
  kind: 'conversation' | 'runtime_prompt';
  targetUserMode?: 'none' | 'optional' | 'required';
  defaultVariables?: Record<string, unknown>;
};

function safeParseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON must be an object');
  }
  return parsed as Record<string, unknown>;
}

function getFeatureScopeLabels(t: (key: string) => string): Record<string, string> {
  return {
    assistant: t('settings.prompt.助手'),
    conversation: t('settings.prompt.会话'),
    soul: t('settings.prompt.Soul_人格'),
    requirement_parser: t('settings.prompt.需求解析'),
    memory: t('settings.prompt.记忆'),
    runtime_customization: t('settings.prompt.运行时定制'),
    code_map: 'CodeMap',
    user_mcp: t('settings.prompt.用户_MCP'),
    stock_analysis: t('settings.prompt.股票分析'),
    repo_review: t('settings.prompt.仓库审查'),
    workteam: t('settings.prompt.工作流'),
  };
}

function getPromptKindLabels(t: (key: string) => string): Record<string, string> {
  return {
    system: t('settings.prompt.系统提示词'),
    instruction: t('settings.prompt.指令片段'),
    user: t('settings.prompt.用户提示词'),
    mixed: t('settings.prompt.混合提示词'),
  };
}

function getPromptLayerLabels(): Record<string, string> {
  return {
    system_base: 'System Base',
    system_persona: 'System Persona',
    system_policy: 'System Policy',
    system_tools: 'System Tools',
    context_runtime: 'Context Runtime',
    context_memory: 'Context Memory',
    user_input: 'User Input',
    task_payload: 'Task Payload',
    derived: 'Derived',
  };
}

function getPromptMutabilityLabels(): Record<string, string> {
  return {
    configurable: 'Configurable',
    parameterized: 'Parameterized',
    runtime_fixed: 'Runtime Fixed',
    derived: 'Derived',
  };
}

function getSourceLabels(t: (key: string) => string): Record<string, string> {
  return {
    builtin: t('settings.prompt.内置默认'),
    system_default: t('settings.prompt.系统覆盖'),
    user_override: t('settings.prompt.用户覆盖'),
    assistant_config: t('settings.prompt.助手配置'),
    conversation_context: t('settings.prompt.会话上下文'),
    soul: t('settings.prompt.Soul_人格'),
    memory: t('settings.prompt.记忆'),
    custom: t('settings.prompt.自定义'),
  };
}

function getTraceKindLabels(t: (key: string) => string): Record<string, string> {
  return {
    agent_envelope: t('settings.prompt.Agent_会话装配'),
    direct_provider: t('settings.prompt.直接模型请求'),
  };
}

function getScenarioTitleLabels(t: (key: string) => string): Record<string, string> {
  return {
    'conversation.runtime': t('settings.prompt.会话运行时'),
    'soul.runtime': t('settings.prompt.Soul_运行时'),
    'repo_review.primary': t('settings.prompt.仓库审查主提示词'),
    'repo_review.worker': t('settings.prompt.仓库审查_Worker'),
    'repo_review.reducer': t('settings.prompt.仓库审查_Reducer'),
    'repo_review.supplemental_file': t('settings.prompt.仓库审查全文补充单文件'),
    'repo_review.supplemental_orchestrator': t('settings.prompt.仓库审查全文补充调度器'),
    'repo_review.digest': t('settings.prompt.仓库审查日报_周报'),
    'stock_analysis.news_intel': t('settings.prompt.股票新闻催化分析'),
    'stock_analysis.ai_summary': t('settings.prompt.股票分析_AI_总结'),
    'stock_analysis.market_review': t('settings.prompt.股票市场复盘'),
    'requirement_parser.base': t('settings.prompt.需求解析'),
    'workteam.smart_creator': t('settings.prompt.工作流_智能创建'),
    'workteam.eval': t('settings.prompt.工作流_结果评估'),
    'workteam.task': t('settings.prompt.工作流_任务下发'),
  };
}

function labelOrRaw(map: Record<string, string>, value?: string | null): string {
  if (!value) return '-';
  return map[value] || value;
}

function formatFeatureScope(t: (key: string) => string, value?: string | null): string {
  return labelOrRaw(getFeatureScopeLabels(t), value);
}

function formatPromptKind(t: (key: string) => string, value?: string | null): string {
  return labelOrRaw(getPromptKindLabels(t), value);
}

function formatPromptLayer(value?: string | null): string {
  return labelOrRaw(getPromptLayerLabels(), value);
}

function formatPromptMutability(value?: string | null): string {
  return labelOrRaw(getPromptMutabilityLabels(), value);
}

function formatSource(t: (key: string) => string, value?: string | null): string {
  return labelOrRaw(getSourceLabels(t), value);
}

function formatTraceKind(t: (key: string) => string, value?: string | null): string {
  return labelOrRaw(getTraceKindLabels(t), value);
}

function formatScenarioTitle(t: (key: string) => string, scenario: PromptPreviewScenario): string {
  return getScenarioTitleLabels(t)[scenario.id] || scenario.title;
}

function formatScenarioDescription(t: (key: string) => string, scenario: PromptPreviewScenario | null): string {
  if (!scenario) return t('settings.prompt.选择一个运行时场景');
  if (scenario.id === 'conversation.runtime') {
    return t('settings.prompt.真实会话链路最终发给模型的内容');
  }
  if (scenario.featureScope === 'repo_review') {
    return t('settings.prompt.仓库审查真实运行时提示词');
  }
  if (scenario.featureScope === 'stock_analysis') {
    return t('settings.prompt.股票分析模块真实运行时提示词预览');
  }
  if (scenario.featureScope === 'workteam') {
    return t('settings.prompt.工作流_模块真实运行时提示词预览');
  }
  return scenario.description;
}

export function SettingsPromptTab({ apiBase }: { apiBase: string }) {
  const { t } = useTranslation('settings');
  const [definitions, setDefinitions] = useState<PromptDefinition[]>([]);
  const [previewScenarios, setPreviewScenarios] = useState<PromptPreviewScenario[]>([]);
  const [users, setUsers] = useState<PromptUser[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [selectedScenarioId, setSelectedScenarioId] = useState('');
  const [scopeKind, setScopeKind] = useState<'system' | 'user'>('system');
  const [targetUserId, setTargetUserId] = useState('');
  const [search, setSearch] = useState('');
  const [featureFilter, setFeatureFilter] = useState('all');
  const [editorText, setEditorText] = useState('');
  const [notesText, setNotesText] = useState('');
  const [defaultTemplate, setDefaultTemplate] = useState('');
  const [lookupMessage, setLookupMessage] = useState('');
  const [previewJson, setPreviewJson] = useState('{}');
  const [previewResult, setPreviewResult] = useState<PromptPreview | null>(null);
  const [conversationChatJid, setConversationChatJid] = useState('');
  const [conversationMessage, setConversationMessage] = useState('');
  const [conversationSender, setConversationSender] = useState('prompt-preview');
  const [conversations, setConversations] = useState<PromptConversation[]>([]);
  const [repoReviewRuns, setRepoReviewRuns] = useState<RepoReviewRunSummary[]>([]);
  const [selectedRepoReviewRunId, setSelectedRepoReviewRunId] = useState('');
  const [traces, setTraces] = useState<PromptTraceRecord[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<PromptTraceRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`${apiBase}/api/prompt-configs/bootstrap`, {
        credentials: 'include',
      });
      const data = await res.json();
      if (cancelled || !data.ok) return;
      setDefinitions(data.definitions || []);
      setPreviewScenarios(data.previewScenarios || []);
      setUsers(data.users || []);
      if (!selectedKey && data.definitions?.[0]?.key) {
        setSelectedKey(data.definitions[0].key);
      }
      if (!selectedScenarioId && data.previewScenarios?.[0]?.id) {
        setSelectedScenarioId(data.previewScenarios[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, selectedKey, selectedScenarioId]);

  useEffect(() => {
    if (!selectedKey) return;
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams({ promptKey: selectedKey });
      if (targetUserId) params.set('targetUserId', targetUserId);
      const res = await fetch(`${apiBase}/api/prompt-configs?${params.toString()}`, {
        credentials: 'include',
      });
      const data = await res.json();
      if (cancelled || !data.ok) return;
      const definition = data.definition as PromptDefinition;
      const selected = scopeKind === 'user' ? (data.user as PromptLookup | null) : (data.system as PromptLookup);
      setDefaultTemplate(definition.defaultTemplate || '');
      setEditorText(
        selected?.config?.template_text ||
          (scopeKind === 'system' ? data.system?.text : definition.defaultTemplate) ||
          '',
      );
      setNotesText(selected?.config?.notes || '');
      setLookupMessage(
        selected?.resolution
          ? `${t('settings.prompt.当前来源')}：${formatSource(t, selected.resolution.source)}`
          : '',
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, selectedKey, targetUserId, scopeKind]);

  useEffect(() => {
    const scenario = previewScenarios.find((item) => item.id === selectedScenarioId);
    if (!scenario) return;
    if (scenario.kind === 'conversation') {
      const vars = scenario.defaultVariables || {};
      setConversationChatJid(typeof vars.chatJid === 'string' ? vars.chatJid : 'web:demo');
      setConversationMessage(typeof vars.messageText === 'string' ? vars.messageText : '');
      setConversationSender(typeof vars.senderName === 'string' ? vars.senderName : 'preview-user');
      setPreviewJson('{}');
      return;
    }
    setPreviewJson(
      JSON.stringify(scenario.defaultVariables || {}, null, 2),
    );
  }, [previewScenarios, selectedScenarioId]);

  useEffect(() => {
    const scenario = previewScenarios.find((item) => item.id === selectedScenarioId);
    if (scenario?.featureScope !== 'repo_review') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/repo-reviews/runs-summary?limit=30`, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const data = await res.json();
        const runs = Array.isArray(data.runs) ? (data.runs as RepoReviewRunSummary[]) : [];
        if (cancelled) return;
        setRepoReviewRuns(runs);
        if (!selectedRepoReviewRunId && runs[0]?.id) {
          setSelectedRepoReviewRunId(runs[0].id);
        }
      } catch {
        // best-effort only
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, previewScenarios, selectedScenarioId, selectedRepoReviewRunId]);

  useEffect(() => {
    const scenario = previewScenarios.find((item) => item.id === selectedScenarioId);
    if (scenario?.kind !== 'conversation') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/conversations`, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const data = (await res.json()) as PromptConversation[];
        if (cancelled || !Array.isArray(data)) return;
        setConversations(data);
        if (!conversationChatJid && data[0]?.jid) {
          setConversationChatJid(data[0].jid);
        }
      } catch {
        // best-effort only
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, previewScenarios, selectedScenarioId, conversationChatJid]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams({ limit: '30' });
      if (selectedKey) params.set('promptKey', selectedKey);
      if (targetUserId) params.set('targetUserId', targetUserId);
      const res = await fetch(`${apiBase}/api/prompt-traces?${params.toString()}`, {
        credentials: 'include',
      });
      const data = await res.json();
      if (cancelled || !data.ok) return;
      setTraces(data.items || []);
      setSelectedTrace((prev) =>
        prev ? (data.items || []).find((item: PromptTraceRecord) => item.id === prev.id) || null : null,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, selectedKey, targetUserId]);

  const featureOptions = useMemo(
    () => ['all', ...Array.from(new Set(definitions.map((item) => item.featureScope))).sort()],
    [definitions],
  );

  const filteredDefinitions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return definitions.filter((definition) => {
      if (featureFilter !== 'all' && definition.featureScope !== featureFilter) return false;
      if (!q) return true;
      return [
        definition.key,
        definition.title,
        definition.description,
        definition.featureScope,
        formatFeatureScope(t, definition.featureScope),
      ]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [definitions, featureFilter, search]);

  const selectedDefinition = definitions.find((item) => item.key === selectedKey) || null;
  const selectedScenario = previewScenarios.find((item) => item.id === selectedScenarioId) || null;
  const promptTitleByKey = useMemo(
    () => new Map(definitions.map((definition) => [definition.key, definition.title])),
    [definitions],
  );
  const formatPromptLabel = (promptKey?: string | null, fallbackScope?: string | null): string => {
    if (promptKey) return promptTitleByKey.get(promptKey) || promptKey;
    return fallbackScope ? formatFeatureScope(t, fallbackScope) : t('settings.prompt.运行时');
  };

  const selectedConversation = useMemo(
    () => conversations.find((item) => item.jid === conversationChatJid) || null,
    [conversations, conversationChatJid],
  );
  const selectedRepoReviewRun = useMemo(
    () => repoReviewRuns.find((item) => item.id === selectedRepoReviewRunId) || null,
    [repoReviewRuns, selectedRepoReviewRunId],
  );

  const replayTraceToPreview = (trace: PromptTraceRecord) => {
    let segments: PromptPreview['segments'] = [];
    let resolution: PromptResolution[] = [];
    let metadata: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(trace.segments_json) as PromptPreview['segments'];
      if (Array.isArray(parsed)) segments = parsed;
    } catch {
      segments = [];
    }
    try {
      const parsed = JSON.parse(trace.resolution_json) as PromptResolution[];
      if (Array.isArray(parsed)) resolution = parsed;
    } catch {
      resolution = [];
    }
    try {
      const parsed = trace.metadata_json ? JSON.parse(trace.metadata_json) : undefined;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = undefined;
    }

    setPreviewResult({
      featureScope: trace.feature_scope,
      promptKey: trace.prompt_key,
      targetUserId: trace.target_user_id || null,
      chatJid: trace.chat_jid || null,
      systemPromptText: trace.system_prompt_text || null,
      userPromptText: trace.user_prompt_text,
      providerInputText: trace.provider_input_text || null,
      cacheFingerprint:
        metadata && typeof metadata.cacheFingerprint === 'string'
          ? metadata.cacheFingerprint
          : null,
      stablePrefixFingerprint:
        metadata && typeof metadata.stablePrefixFingerprint === 'string'
          ? metadata.stablePrefixFingerprint
          : null,
      segments,
      resolution,
      metadata,
    });
    setSelectedTrace(trace);
    setTargetUserId(trace.target_user_id || '');
    if (trace.chat_jid) {
      setSelectedScenarioId('conversation.runtime');
      setConversationChatJid(trace.chat_jid);
    } else if (trace.prompt_key) {
      const matchedScenario = previewScenarios.find(
        (scenario) => scenario.promptKey === trace.prompt_key,
      );
      if (matchedScenario) {
        setSelectedScenarioId(matchedScenario.id);
      }
    }
    setLookupMessage(t('settings.prompt.已从真实记录回放到预览面板'));
  };

  const handleLoadLatestTrace = async () => {
    const featureScope = selectedScenario?.featureScope;
    if (!featureScope) return;
    const params = new URLSearchParams({
      featureScope,
      limit: '1',
    });
    if (selectedScenario?.promptKey) {
      params.set('promptKey', selectedScenario.promptKey);
    }
    try {
      const res = await fetch(`${apiBase}/api/prompt-traces?${params.toString()}`, {
        credentials: 'include',
      });
      const data = await res.json();
      const trace = (data.items || [])[0] as PromptTraceRecord | undefined;
      if (!data.ok || !trace) {
        setLookupMessage(data.error || t('settings.prompt.没有可用的真实记录'));
        return;
      }
      replayTraceToPreview(trace);
    } catch (err) {
      setLookupMessage(err instanceof Error ? err.message : t('settings.prompt.加载真实记录失败'));
    }
  };

  const handleLoadRepoReviewRunTrace = async () => {
    if (!selectedRepoReviewRunId) return;
    try {
      const params = new URLSearchParams({
        featureScope: 'repo_review',
        limit: '200',
      });
      const res = await fetch(`${apiBase}/api/prompt-traces?${params.toString()}`, {
        credentials: 'include',
      });
      const data = await res.json();
      const items = Array.isArray(data.items) ? (data.items as PromptTraceRecord[]) : [];
      const matched = items.find((trace) => {
        if (!trace.metadata_json) return false;
        try {
          const metadata = JSON.parse(trace.metadata_json) as Record<string, unknown>;
          return metadata.runId === selectedRepoReviewRunId;
        } catch {
          return false;
        }
      });
      if (!data.ok || !matched) {
        setLookupMessage(data.error || t('settings.prompt.该运行暂无可回放的提示词记录'));
        return;
      }
      replayTraceToPreview(matched);
    } catch (err) {
      setLookupMessage(err instanceof Error ? err.message : t('settings.prompt.加载运行记录失败'));
    }
  };

  const handleLoadLatestConversationMessage = async () => {
    if (!conversationChatJid) return;
    try {
      const res = await fetch(
        `${apiBase}/api/conversations/${encodeURIComponent(conversationChatJid)}/messages?limit=20`,
        { credentials: 'include' },
      );
      const data = await res.json();
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const latestHuman = [...messages]
        .reverse()
        .find(
          (message) =>
            !message?.is_bot_message &&
            !message?.is_from_me &&
            typeof message?.content === 'string' &&
            message.content.trim(),
        );
      if (!res.ok || !latestHuman) {
        setLookupMessage(data.error || t('settings.prompt.未找到最近一条真实用户消息'));
        return;
      }
      setConversationMessage(String(latestHuman.content || ''));
      setConversationSender(String(latestHuman.sender_name || 'preview-user'));
      setLookupMessage(t('settings.prompt.已载入最近一条真实用户消息'));
    } catch (err) {
      setLookupMessage(err instanceof Error ? err.message : t('settings.prompt.读取最近消息失败'));
    }
  };

  const handleSave = async () => {
    if (!selectedDefinition) return;
    if (selectedDefinition.mutability && selectedDefinition.mutability !== 'configurable') {
      setLookupMessage('该提示词当前为只读运行时片段');
      return;
    }
    const res = await fetch(`${apiBase}/api/prompt-configs/${encodeURIComponent(selectedDefinition.key)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scopeKind,
        targetUserId: scopeKind === 'user' ? targetUserId : '',
        templateText: editorText,
        notes: notesText,
      }),
    });
    const data = await res.json();
    setLookupMessage(data.ok ? t('settings.prompt.已保存') : data.error || t('settings.prompt.保存失败'));
  };

  const handleReset = async () => {
    if (!selectedDefinition) return;
    if (selectedDefinition.mutability && selectedDefinition.mutability !== 'configurable') {
      setLookupMessage('该提示词当前为只读运行时片段');
      return;
    }
    const params = new URLSearchParams({ scopeKind });
    if (scopeKind === 'user' && targetUserId) params.set('targetUserId', targetUserId);
    const res = await fetch(
      `${apiBase}/api/prompt-configs/${encodeURIComponent(selectedDefinition.key)}?${params.toString()}`,
      {
        method: 'DELETE',
        credentials: 'include',
      },
    );
    const data = await res.json();
    if (data.ok) {
      setEditorText(defaultTemplate);
      setNotesText('');
      setLookupMessage(t('settings.prompt.已恢复回退'));
    } else {
      setLookupMessage(data.error || t('settings.prompt.恢复失败'));
    }
  };

  const handleTemplatePreview = async () => {
    if (!selectedScenario && !selectedDefinition) return;
    try {
      const variables = safeParseJsonObject(previewJson);
      if (selectedScenario?.kind === 'runtime_prompt') {
        const res = await fetch(`${apiBase}/api/prompt-configs/preview`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'template',
            scenarioId: selectedScenario.id,
            promptKey: selectedScenario.promptKey,
            targetUserId: targetUserId || '',
            variables,
          }),
        });
        const data = await res.json();
        setPreviewResult(data.ok ? data.preview : null);
        setLookupMessage(data.ok ? t('settings.prompt.模块预览已更新') : data.error || t('settings.prompt.预览失败'));
        return;
      }
      if (!selectedDefinition) return;
      const res = await fetch(`${apiBase}/api/prompt-configs/preview`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'template',
          promptKey: selectedDefinition.key,
          targetUserId: scopeKind === 'user' ? targetUserId : '',
          variables,
        }),
      });
      const data = await res.json();
      setPreviewResult(data.ok ? data.preview : null);
      setLookupMessage(data.ok ? t('settings.prompt.模板预览已更新') : data.error || t('settings.prompt.预览失败'));
    } catch (err) {
      setLookupMessage(err instanceof Error ? err.message : t('settings.prompt.预览_JSON_无效'));
    }
  };

  const handleConversationPreview = async () => {
    const res = await fetch(`${apiBase}/api/prompt-configs/preview`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'conversation',
        scenarioId: selectedScenarioId || 'conversation.runtime',
        chatJid: conversationChatJid,
        messageText: conversationMessage,
        senderName: conversationSender,
      }),
    });
    const data = await res.json();
    setPreviewResult(data.ok ? data.preview : null);
    setLookupMessage(data.ok ? t('settings.prompt.会话预览已更新') : data.error || t('settings.prompt.会话预览失败'));
  };

  return (
    <div className="settings-section settings-general-panel" style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)', gap: 16 }}>
        <section className="settings-section settings-general-panel" style={{ margin: 0 }}>
          <h3>{t('settings.prompt.提示词配置项')}</h3>
          <div className="settings-field-grid" style={{ gap: 8 }}>
            <input className="nc-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('settings.prompt.搜索_key_标题_功能域')} />
            <select className="nc-input" value={featureFilter} onChange={(e) => setFeatureFilter(e.target.value)}>
              {featureOptions.map((option) => (
                <option key={option} value={option}>
                  {option === 'all' ? t('settings.prompt.全部功能域') : formatFeatureScope(t, option)}
                </option>
              ))}
            </select>
          </div>
          <div style={{ marginTop: 12, maxHeight: 520, overflow: 'auto', display: 'grid', gap: 8 }}>
            {filteredDefinitions.map((definition) => (
              <button
                key={definition.key}
                type="button"
                className={`btn ${selectedKey === definition.key ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setSelectedKey(definition.key)}
                style={{ textAlign: 'left' }}
              >
                <div><strong>{definition.title}</strong></div>
                <div className="settings-hint">
                  {formatFeatureScope(t, definition.featureScope)} · {formatPromptKind(t, definition.promptKind)} · {formatPromptLayer(definition.layer)} · {formatPromptMutability(definition.mutability)}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section settings-general-panel" style={{ margin: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h3>{selectedDefinition?.title || t('settings.prompt.选择一个提示词')}</h3>
              <div className="settings-hint">{selectedDefinition?.description}</div>
              <div className="settings-hint">
                {selectedDefinition
                  ? `${formatFeatureScope(t, selectedDefinition.featureScope)} · ${formatPromptKind(t, selectedDefinition.promptKind)} · ${formatPromptLayer(selectedDefinition.layer)} · ${formatPromptMutability(selectedDefinition.mutability)}`
                  : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select className="nc-input" value={scopeKind} onChange={(e) => setScopeKind(e.target.value === 'user' ? 'user' : 'system')}>
                <option value="system">{t('settings.prompt.系统默认')}</option>
                <option value="user">{t('settings.prompt.用户覆盖')}</option>
              </select>
              <select className="nc-input" value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)} disabled={scopeKind !== 'user'}>
                <option value="">{t('settings.prompt.选择用户')}</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>{user.username}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-hint" style={{ marginTop: 8 }}>{lookupMessage}</div>
          <div className="settings-hint" style={{ marginTop: 4 }}>
            {t('settings.prompt.支持变量')}: {selectedDefinition?.variables.join(', ') || t('settings.prompt.无')}
          </div>

          <label className="config-field" style={{ marginTop: 12 }}>
            <span>{t('settings.prompt.模板')}</span>
            <textarea
              className="nc-input"
              rows={16}
              value={editorText}
              onChange={(e) => setEditorText(e.target.value)}
              readOnly={selectedDefinition?.mutability !== 'configurable'}
            />
          </label>
          <label className="config-field">
            <span>{t('settings.prompt.备注')}</span>
            <textarea
              className="nc-input"
              rows={3}
              value={notesText}
              onChange={(e) => setNotesText(e.target.value)}
              readOnly={selectedDefinition?.mutability !== 'configurable'}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!selectedDefinition || selectedDefinition.mutability !== 'configurable' || (scopeKind === 'user' && !targetUserId)}>{t('settings.prompt.保存')}</button>
            <button type="button" className="btn btn-secondary" onClick={handleReset} disabled={!selectedDefinition || selectedDefinition.mutability !== 'configurable'}>{t('settings.prompt.删除覆盖_回退')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setEditorText(defaultTemplate)} disabled={!selectedDefinition}>{t('settings.prompt.载入内置默认')}</button>
          </div>
        </section>
      </div>

      <section className="settings-section settings-general-panel" style={{ margin: 0 }}>
        <h3>{t('settings.prompt.运行时预览')}</h3>
        <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
          <select
            className="nc-input"
            value={selectedScenarioId}
            onChange={(e) => setSelectedScenarioId(e.target.value)}
          >
            {previewScenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {formatScenarioTitle(t, scenario)} · {formatFeatureScope(t, scenario.featureScope)}
              </option>
            ))}
          </select>
          <div className="settings-hint">{formatScenarioDescription(t, selectedScenario)}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleLoadLatestTrace}
              disabled={!selectedScenario}
            >
              {t('settings.prompt.载入最近一次真实记录')}
            </button>
            {selectedScenario?.featureScope === 'repo_review' && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleLoadRepoReviewRunTrace}
                disabled={!selectedRepoReviewRunId}
              >
                {t('settings.prompt.载入所选运行的真实记录')}
              </button>
            )}
          </div>
        </div>
        {selectedScenario?.featureScope === 'repo_review' && (
          <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
            <div className="settings-hint">{t('settings.prompt.仓库审查真实运行')}</div>
            <select
              className="nc-input"
              value={selectedRepoReviewRunId}
              onChange={(e) => setSelectedRepoReviewRunId(e.target.value)}
            >
              {repoReviewRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {(run.branch || '-')} · {(run.status || run.overall || '-')} · {run.id}
                </option>
              ))}
            </select>
            {selectedRepoReviewRun && (
              <div className="settings-hint">
                {selectedRepoReviewRun.summary || t('settings.prompt.无摘要')} · {selectedRepoReviewRun.actor || '-'}
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) minmax(320px, 1fr)', gap: 16 }}>
          <div>
            <div className="settings-hint">{t('settings.prompt.运行时样例变量_JSON')}</div>
            <textarea className="nc-input" rows={8} value={previewJson} onChange={(e) => setPreviewJson(e.target.value)} />
            <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={handleTemplatePreview} disabled={!selectedScenario && !selectedDefinition}>
              {t('settings.prompt.预览最终提示词')}
            </button>
          </div>
          <div>
            <div className="settings-hint">{t('settings.prompt.会话级运行时预览')}</div>
            {selectedScenario?.kind === 'conversation' && conversations.length > 0 ? (
              <select
                className="nc-input"
                value={conversationChatJid}
                onChange={(e) => setConversationChatJid(e.target.value)}
              >
                {conversations.map((conversation) => (
                  <option key={conversation.jid} value={conversation.jid}>
                    {(conversation.custom_title || conversation.display_name || conversation.name || conversation.jid)} · {conversation.jid}
                  </option>
                ))}
              </select>
            ) : (
              <input className="nc-input" value={conversationChatJid} onChange={(e) => setConversationChatJid(e.target.value)} placeholder={t('settings.prompt.chatJid_示例')} />
            )}
            {selectedConversation && (
              <div className="settings-hint" style={{ marginTop: 6 }}>
                {t('settings.prompt.当前会话')}: {selectedConversation.custom_title || selectedConversation.display_name || selectedConversation.name || selectedConversation.jid}
              </div>
            )}
            <input className="nc-input" style={{ marginTop: 8 }} value={conversationSender} onChange={(e) => setConversationSender(e.target.value)} placeholder={t('settings.prompt.发送者名称')} />
            <textarea className="nc-input" rows={5} style={{ marginTop: 8 }} value={conversationMessage} onChange={(e) => setConversationMessage(e.target.value)} placeholder={t('settings.prompt.输入要发送给_AI_的用户消息')} />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button type="button" className="btn btn-secondary" onClick={handleLoadLatestConversationMessage} disabled={!conversationChatJid}>
                {t('settings.prompt.读取最近一条真实用户消息')}
              </button>
            </div>
            <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={handleConversationPreview}>
              {t('settings.prompt.预览会话最终提示词')}
            </button>
          </div>
        </div>
      </section>

      {previewResult && (
        <section className="settings-section settings-general-panel" style={{ margin: 0 }}>
          <h3>{t('settings.prompt.最终装配结果')}</h3>
          <div className="settings-hint">
            {formatFeatureScope(t, previewResult.featureScope)} / {previewResult.promptKey ? formatPromptLabel(previewResult.promptKey) : previewResult.chatJid || t('settings.prompt.预览')}
          </div>
          {(previewResult.stablePrefixFingerprint || previewResult.cacheFingerprint) && (
            <div className="settings-hint" style={{ marginTop: 8 }}>
              {previewResult.stablePrefixFingerprint ? `stable ${previewResult.stablePrefixFingerprint.slice(0, 16)}…` : ''}
              {previewResult.stablePrefixFingerprint && previewResult.cacheFingerprint ? ' · ' : ''}
              {previewResult.cacheFingerprint ? `full ${previewResult.cacheFingerprint.slice(0, 16)}…` : ''}
            </div>
          )}
          {previewResult.systemPromptText && (
            <label className="config-field" style={{ marginTop: 12 }}>
              <span>{t('settings.prompt.系统提示词')}</span>
              <textarea className="nc-input" rows={8} readOnly value={previewResult.systemPromptText} />
            </label>
          )}
          <label className="config-field" style={{ marginTop: 12 }}>
            <span>{t('settings.prompt.用户提示词_请求载荷')}</span>
            <textarea className="nc-input" rows={12} readOnly value={previewResult.userPromptText} />
          </label>
          <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            {previewResult.segments.map((segment) => (
              <details key={segment.id} open>
                <summary>{segment.label} · {formatSource(t, segment.source)} · {formatPromptLayer(segment.layer)}</summary>
                <textarea className="nc-input" rows={6} readOnly value={segment.content} />
              </details>
            ))}
          </div>
        </section>
      )}

      <section className="settings-section settings-general-panel" style={{ margin: 0 }}>
        <h3>{t('settings.prompt.提示词真实记录')}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 420px) minmax(0, 1fr)', gap: 16 }}>
          <div style={{ maxHeight: 420, overflow: 'auto', display: 'grid', gap: 8 }}>
            {traces.map((trace) => (
              <button
                key={trace.id}
                type="button"
                className={`btn ${selectedTrace?.id === trace.id ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setSelectedTrace(trace)}
                style={{ textAlign: 'left' }}
              >
                <div><strong>{formatPromptLabel(trace.prompt_key, trace.feature_scope)}</strong></div>
                <div className="settings-hint">{formatFeatureScope(t, trace.feature_scope)} · {formatTraceKind(t, trace.trace_kind)} · {trace.created_at}</div>
                <div className="settings-hint">{trace.chat_jid || trace.target_user_id || '-'}</div>
              </button>
            ))}
          </div>
          <div>
            {selectedTrace ? (
              <div style={{ display: 'grid', gap: 12 }}>
                <div className="settings-hint">
                  {formatFeatureScope(t, selectedTrace.feature_scope)} / {formatPromptLabel(selectedTrace.prompt_key, selectedTrace.feature_scope)}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => replayTraceToPreview(selectedTrace)}
                  >
                    {t('settings.prompt.回放到试看面板')}
                  </button>
                </div>
                {selectedTrace.system_prompt_text && (
                  <label className="config-field">
                    <span>{t('settings.prompt.系统提示词')}</span>
                    <textarea className="nc-input" rows={8} readOnly value={selectedTrace.system_prompt_text} />
                  </label>
                )}
                <label className="config-field">
                  <span>{t('settings.prompt.用户提示词')}</span>
                  <textarea className="nc-input" rows={10} readOnly value={selectedTrace.user_prompt_text} />
                </label>
                <details open>
                  <summary>{t('settings.prompt.分段_JSON')}</summary>
                  <textarea className="nc-input" rows={10} readOnly value={selectedTrace.segments_json} />
                </details>
                <details>
                  <summary>{t('settings.prompt.来源解析_JSON')}</summary>
                  <textarea className="nc-input" rows={8} readOnly value={selectedTrace.resolution_json} />
                </details>
                <details>
                  <summary>{t('settings.prompt.元数据_JSON')}</summary>
                  <textarea className="nc-input" rows={8} readOnly value={selectedTrace.metadata_json || ''} />
                </details>
              </div>
            ) : (
              <div className="settings-hint">{t('settings.prompt.选择一条记录查看详情')}</div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
