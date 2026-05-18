import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppSelect, type AppSelectOption } from '../components/AppSelect';
import { TabBar, type Tab } from '../components/common/TabBar';
import { Pagination } from '../components/common/Pagination';
import { NcSelect, NcCheckbox } from '../components/common';
import { useNavigatedTab } from '../hooks/useNavigatedTab';
import { TavernPersonasPanel } from '../components/soul/TavernPersonasPanel';

export interface SoulPageProps {
  apiBase: string;
}

interface SoulConfig {
  id: string;
  user_id: string;
  name: string | null;
  emoji: string | null;
  emoji_enabled: number;
  creature: string | null;
  vibe: string | null;
  persona_prompt: string | null;
  tone: string | null;
  language_preference: string | null;
  extra_instructions: string | null;
  user_nickname: string | null;
  behavior_rules: string | null;
  auto_evolve: number;
  consolidation_config: string | null;
  enabled: number;
}

interface ConsolidationConfig {
  minFrequency: number;
  minConfidence: number;
  insightActivation: number;
  cooldownHours: number;
}

interface BehaviorRuleItem {
  id: string;
  text: string;
  enabled: boolean;
}

interface SoulMemory {
  id: string;
  user_id: string;
  scope: string;
  conversation_id: string | null;
  category: string;
  content: string;
  importance: number;
  confidence: number;
  source: string | null;
  tier: string;
  promoted_from: string | null;
  last_verified_at: string | null;
  access_count: number;
  last_accessed_at: string | null;
  expires_at: string | null;
  source_event_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
}

interface MemoryEvent {
  id: string;
  user_id: string | null;
  scope: string;
  action_type: string;
  target_type: string;
  target_id: string | null;
  conversation_id: string | null;
  source_message_id: string | null;
  before_snapshot: string | null;
  after_snapshot: string | null;
  decision_reason: string | null;
  metadata_json: string | null;
  created_at: string;
}

interface MemoryDocument {
  doc_id: string;
  scope: string;
  owner_type: string;
  owner_id: string;
  path_ref: string | null;
  source_type: string;
  title: string | null;
  body: string;
  metadata_json: string | null;
  updated_at: string;
}

interface MemorySkill {
  id: string;
  user_id: string | null;
  scope: string;
  name: string;
  trigger_pattern: string;
  body: string;
  termination_condition: string | null;
  success_count: number;
  failure_count: number;
  last_used_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface Observation {
  id: string;
  user_id: string;
  conversation_id: string | null;
  category: string;
  content: string;
  observation_type: string;
  frequency: number;
  last_seen_at: string;
  confidence: number;
  source: string;
  promoted_to: string | null;
  created_at: string;
}

interface PersonaInsight {
  id: string;
  user_id: string;
  insight_type: string;
  content: string;
  evidence_count: number;
  confidence: number;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ConsolidationLog {
  id: string;
  user_id: string;
  run_type: string;
  observations_reviewed: number;
  promoted: number;
  merged: number;
  pruned: number;
  insights_generated: number;
  duration_ms: number | null;
  created_at: string;
}

interface SoulPreset {
  id: string;
  label: string;
  description: string;
}

type NoticeTone = 'success' | 'error';
interface NoticeState { tone: NoticeTone; text: string; }

type TabId = 'persona' | 'memory' | 'evolution' | 'audit' | 'advanced';
const VALID_TAB_IDS: ReadonlySet<string> = new Set<TabId>(['persona', 'memory', 'evolution', 'audit', 'advanced']);

const ACTION_TYPE_COLORS: Record<string, string> = {
  ADD: 'var(--success-bg, #1a3a2a)',
  PROMOTE: 'var(--accent-bg, #1a2a3a)',
  MERGE: 'var(--surface-card-strong, #2a2a3a)',
  DELETE: 'var(--error-bg, #3a1a1a)',
  EVICT: 'var(--error-bg, #3a1a1a)',
  SKIP: 'var(--bg-tertiary, #2a2a2a)',
  RECALL: 'var(--accent-bg, #1a3a3a)',
  UPDATE: 'var(--success-bg, #2a3a1a)',
};

const DEFAULT_CONSOLIDATION: ConsolidationConfig = {
  minFrequency: 2,
  minConfidence: 0.5,
  insightActivation: 0.6,
  cooldownHours: 24,
};

function parseConsolidationConfig(raw: string | null | undefined): ConsolidationConfig {
  if (!raw) return { ...DEFAULT_CONSOLIDATION };
  try {
    const parsed = JSON.parse(raw) as Partial<ConsolidationConfig>;
    return {
      minFrequency: parsed.minFrequency ?? DEFAULT_CONSOLIDATION.minFrequency,
      minConfidence: parsed.minConfidence ?? DEFAULT_CONSOLIDATION.minConfidence,
      insightActivation: parsed.insightActivation ?? DEFAULT_CONSOLIDATION.insightActivation,
      cooldownHours: parsed.cooldownHours ?? DEFAULT_CONSOLIDATION.cooldownHours,
    };
  } catch {
    return { ...DEFAULT_CONSOLIDATION };
  }
}

function parseBehaviorRules(raw: string | null | undefined): BehaviorRuleItem[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((item: Record<string, unknown>, i: number) => ({
      id: (item.id as string) || `rule-${i}`,
      text: String(item.text ?? ''),
      enabled: item.enabled !== false,
    }));
  } catch {
    return [];
  }
}

function serializeBehaviorRules(rules: BehaviorRuleItem[]): string | null {
  if (rules.length === 0) return null;
  return JSON.stringify(rules.map((r) => ({ id: r.id, text: r.text, enabled: r.enabled })));
}

function createEmptySoul(): Partial<SoulConfig> {
  return {
    name: '',
    emoji: '',
    emoji_enabled: 0,
    creature: '',
    vibe: '',
    persona_prompt: '',
    tone: 'default',
    language_preference: '',
    extra_instructions: '',
    user_nickname: '',
    behavior_rules: null,
    auto_evolve: 1,
    consolidation_config: null,
    enabled: 1,
  };
}

function confidenceBar(value: number) {
  const pct = Math.round(value * 100);
  const color = pct >= 70 ? 'var(--success-text, #4ade80)'
    : pct >= 40 ? 'var(--warning-text, #fbbf24)'
    : 'var(--text-secondary, #888)';
  return (
    <span className="soul-confidence-bar">
      <span className="soul-confidence-bar-track">
        <span
          className="soul-confidence-bar-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </span>
      <span className="soul-confidence-bar-label">{pct}%</span>
    </span>
  );
}

function badge(text: string, bg?: string) {
  return (
    <span className="soul-badge" style={bg ? { background: bg } : undefined}>
      {text}
    </span>
  );
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleDateString();
}

function isExpired(value: string | null | undefined): boolean {
  return !!value && new Date(value).getTime() <= Date.now();
}

export function SoulPage({ apiBase }: SoulPageProps) {
  const { t } = useTranslation('soul');
  const [surfaceMode, setSurfaceMode] = useState<'soul' | 'tavern'>('soul');

  const TABS: Array<{ id: TabId; label: string }> = [
    { id: 'persona', label: t('auto.ad0e443e') },
    { id: 'memory', label: t('auto.2c567aa6') },
    { id: 'evolution', label: t('auto.7d286976') },
    { id: 'audit', label: t('auto.a722bf43') },
    { id: 'advanced', label: t('高级设置') },
  ];

  const TONE_OPTIONS = [
    { value: 'default', label: t('默认') },
    { value: 'warm', label: t('温暖') },
    { value: 'gentle', label: t('温柔') },
    { value: 'casual', label: t('随意') },
    { value: 'playful', label: t('活泼') },
    { value: 'witty', label: t('幽默') },
    { value: 'energetic', label: t('元气') },
    { value: 'cool', label: t('酷感') },
    { value: 'professional', label: t('专业') },
    { value: 'formal', label: t('正式') },
    { value: 'academic', label: t('学术') },
  ];

  const CATEGORY_OPTIONS = [
    { value: 'general', label: t('通用') },
    { value: 'identity', label: t('身份') },
    { value: 'preference', label: t('偏好') },
    { value: 'habit', label: t('习惯') },
    { value: 'fact', label: t('事实') },
    { value: 'skill', label: t('技能') },
    { value: 'relationship', label: t('关系') },
  ];

  const SOURCE_LABELS: Record<string, string> = {
    manual: t('手动'),
    chat_auto: t('聊天'),
    llm_extract: t('AI提取'),
    agent_tool: t('工具'),
    consolidation: t('整合'),
    import: t('导入'),
  };

  const INSIGHT_TYPE_LABELS: Record<string, string> = {
    communication_style: t('沟通方式'),
    response_preference: t('回复偏好'),
    topic_depth: t('话题深度'),
    humor_tolerance: t('幽默接受度'),
    formality_level: t('正式程度'),
    emoji_preference: t('表情偏好'),
  };

  const INSIGHT_STATUS_LABELS: Record<string, string> = {
    candidate: t('待确认'),
    active: t('已启用'),
    retired: t('已退休'),
  };

  const SCOPE_LABELS: Record<string, string> = {
    global: t('全局'),
    group: t('群组'),
    conversation: t('会话'),
  };

  const ACTION_TYPE_LABELS: Record<string, string> = {
    ADD: t('新增'),
    UPDATE: t('更新'),
    DELETE: t('删除'),
    MERGE: t('合并'),
    EVICT: t('淘汰'),
    PROMOTE: t('提升'),
    SKIP: t('跳过'),
    RECALL: t('召回'),
  };

  const DOC_SOURCE_TYPE_LABELS: Record<string, string> = {
    memory_file: t('记忆文件'),
    identity_memory: t('身份记忆'),
    user_memory: t('用户记忆投影'),
    compaction_summary: t('压缩摘要'),
  };

  const [activeTab, setActiveTab] = useNavigatedTab<TabId>('soul', VALID_TAB_IDS, 'persona');
  const [soul, setSoul] = useState<Partial<SoulConfig>>(createEmptySoul());
  const [memories, setMemories] = useState<SoulMemory[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [insights, setInsights] = useState<PersonaInsight[]>([]);
  const [consolidationLogs, setConsolidationLogs] = useState<ConsolidationLog[]>([]);
  const [presets, setPresets] = useState<SoulPreset[]>([]);
  const [hasSoul, setHasSoul] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [consolidating, setConsolidating] = useState(false);

  const [memoryEvents, setMemoryEvents] = useState<MemoryEvent[]>([]);
  const [memoryDocuments, setMemoryDocuments] = useState<MemoryDocument[]>([]);
  const [memorySkills, setMemorySkills] = useState<MemorySkill[]>([]);

  const [newMemoryContent, setNewMemoryContent] = useState('');
  const [newMemoryCategory, setNewMemoryCategory] = useState('general');
  const [newMemoryImportance, setNewMemoryImportance] = useState(5);
  const [memoryTierFilter, setMemoryTierFilter] = useState<string>('all');
  const [memoryScopeFilter, setMemoryScopeFilter] = useState<string>('all');
  type MemorySubTab = 'memories' | 'documents' | 'skills';
  const [memorySubTab, setMemorySubTab] = useState<MemorySubTab>('memories');
  const memorySubTabs: Tab[] = [
    { key: 'memories', label: t('持久记忆'), badge: memories.length },
    { key: 'documents', label: t('文件记忆'), badge: memoryDocuments.length },
    { key: 'skills', label: t('技能记忆'), badge: memorySkills.length },
  ];
  const [memoryCategoryFilter, setMemoryCategoryFilter] = useState<string>('all');
  const [behaviorRules, setBehaviorRules] = useState<BehaviorRuleItem[]>([]);
  const [newRuleText, setNewRuleText] = useState('');
  const [consolidationCfg, setConsolidationCfg] = useState<ConsolidationConfig>(DEFAULT_CONSOLIDATION);
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('general');
  const [editImportance, setEditImportance] = useState(5);
  const [auditActionFilter, setAuditActionFilter] = useState<string>('all');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const AUDIT_PAGE_SIZE = 20;
  const AUDIT_FOCUS_ACTIONS = ['RECALL', 'PROMOTE', 'SKIP', 'MERGE'];
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const editContentRef = useRef<HTMLTextAreaElement>(null);

  const showNotice = useCallback((tone: NoticeTone, text: string) => {
    setNotice({ tone, text });
    setTimeout(() => setNotice(null), 3000);
  }, []);

  const apiFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`${apiBase}${path}`, {
        credentials: 'include',
        ...init,
      });
      return res.json();
    },
    [apiBase],
  );

  const fetchSoul = useCallback(async () => {
    try {
      const data = await apiFetch('/api/soul');
      if (data.ok && data.soul) {
        setSoul(data.soul);
        setHasSoul(true);
        setBehaviorRules(parseBehaviorRules(data.soul.behavior_rules));
        setConsolidationCfg(parseConsolidationConfig(data.soul.consolidation_config));
      } else {
        setSoul(createEmptySoul());
        setHasSoul(false);
        setBehaviorRules([]);
        setConsolidationCfg({ ...DEFAULT_CONSOLIDATION });
      }
    } catch {
      setSoul(createEmptySoul());
      setHasSoul(false);
    }
  }, [apiFetch]);

  const fetchMemories = useCallback(async () => {
    try {
      const data = await apiFetch('/api/soul/memories');
      if (data.ok) setMemories(data.memories || []);
    } catch { setMemories([]); }
  }, [apiFetch]);

  const fetchObservations = useCallback(async () => {
    try {
      const data = await apiFetch('/api/soul/observations');
      if (data.ok) setObservations(data.observations || []);
    } catch { setObservations([]); }
  }, [apiFetch]);

  const fetchInsights = useCallback(async () => {
    try {
      const data = await apiFetch('/api/soul/insights');
      if (data.ok) setInsights(data.insights || []);
    } catch { setInsights([]); }
  }, [apiFetch]);

  const fetchConsolidationLogs = useCallback(async () => {
    try {
      const data = await apiFetch('/api/soul/consolidation-log');
      if (data.ok) setConsolidationLogs(data.logs || []);
    } catch { setConsolidationLogs([]); }
  }, [apiFetch]);

  const fetchPresets = useCallback(async () => {
    try {
      const data = await apiFetch('/api/soul/presets');
      if (data.ok) setPresets(data.presets || []);
    } catch { setPresets([]); }
  }, [apiFetch]);

  const fetchMemoryEvents = useCallback(async () => {
    try {
      const data = await apiFetch('/api/soul/memory-events?limit=100');
      if (data.ok) setMemoryEvents(data.events || []);
    } catch { setMemoryEvents([]); }
  }, [apiFetch]);

  const fetchMemoryDocuments = useCallback(async () => {
    try {
      const data = await apiFetch('/api/soul/memory-documents?limit=200');
      if (data.ok) setMemoryDocuments(data.documents || []);
    } catch { setMemoryDocuments([]); }
  }, [apiFetch]);

  const fetchMemorySkills = useCallback(async () => {
    try {
      const data = await apiFetch('/api/soul/memory-skills');
      if (data.ok) setMemorySkills(data.skills || []);
    } catch { setMemorySkills([]); }
  }, [apiFetch]);

  useEffect(() => {
    Promise.all([
      fetchSoul(), fetchMemories(), fetchObservations(),
      fetchInsights(), fetchConsolidationLogs(), fetchPresets(),
      fetchMemoryEvents(), fetchMemoryDocuments(), fetchMemorySkills(),
    ]).finally(() => setLoading(false));
  }, [fetchSoul, fetchMemories, fetchObservations, fetchInsights, fetchConsolidationLogs, fetchPresets, fetchMemoryEvents, fetchMemoryDocuments, fetchMemorySkills]);

  useEffect(() => {
    setAuditPage(1);
  }, [auditActionFilter]);

  const handleSave = async () => {
    try {
      const serializedRules = serializeBehaviorRules(behaviorRules);
      const data = await apiFetch('/api/soul', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: soul.name || null,
          emoji: soul.emoji || null,
          emojiEnabled: !!soul.emoji_enabled,
          creature: soul.creature || null,
          vibe: soul.vibe || null,
          personaPrompt: soul.persona_prompt || null,
          tone: soul.tone || null,
          languagePreference: soul.language_preference || null,
          extraInstructions: soul.extra_instructions || null,
          userNickname: soul.user_nickname || null,
          behaviorRules: serializedRules,
          autoEvolve: !!soul.auto_evolve,
          consolidationConfig: JSON.stringify(consolidationCfg),
          enabled: soul.enabled !== 0,
        }),
      });
      if (data.ok) {
        setSoul(data.soul);
        setHasSoul(true);
        setBehaviorRules(parseBehaviorRules(data.soul.behavior_rules));
        setConsolidationCfg(parseConsolidationConfig(data.soul.consolidation_config));
        showNotice('success', t('灵魂配置已保存'));
      } else {
        showNotice('error', data.error || t('保存失败'));
      }
    } catch (err) { showNotice('error', String(err)); }
  };

  const handleApplyPreset = async (presetId: string) => {
    try {
      const data = await apiFetch('/api/soul/preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId }),
      });
      if (data.ok) {
        setSoul(data.soul);
        setHasSoul(true);
        showNotice('success', t('预设模板已应用'));
      } else {
        showNotice('error', data.error || t('应用失败'));
      }
    } catch (err) { showNotice('error', String(err)); }
  };

  const handleDelete = async () => {
    if (!confirm(t('确定删除灵魂配置吗？'))) return;
    try {
      const data = await apiFetch('/api/soul', { method: 'DELETE' });
      if (data.ok) {
        setSoul(createEmptySoul());
        setHasSoul(false);
        showNotice('success', t('灵魂配置已删除'));
      }
    } catch (err) { showNotice('error', String(err)); }
  };

  const handleAddMemory = async () => {
    if (!newMemoryContent.trim()) return;
    try {
      const data = await apiFetch('/api/soul/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: newMemoryContent,
          category: newMemoryCategory,
          importance: newMemoryImportance,
          source: 'manual',
        }),
      });
      if (data.ok) {
        setNewMemoryContent('');
        setNewMemoryImportance(5);
        await Promise.all([fetchMemories(), fetchMemoryDocuments(), fetchMemoryEvents()]);
        showNotice('success', t('记忆已添加'));
      }
    } catch (err) { showNotice('error', String(err)); }
  };

  const handleDeleteMemory = async (memoryId: string) => {
    try {
      const data = await apiFetch(`/api/soul/memories/${memoryId}`, { method: 'DELETE' });
      if (data.ok) {
        await Promise.all([fetchMemories(), fetchMemoryDocuments(), fetchMemoryEvents()]);
        showNotice('success', t('记忆已删除'));
      }
    } catch (err) { showNotice('error', String(err)); }
  };

  const handleStartEdit = (mem: SoulMemory) => {
    setEditingMemoryId(mem.id);
    setEditContent(mem.content);
    setEditCategory(mem.category);
    setEditImportance(mem.importance);
    setTimeout(() => editContentRef.current?.focus(), 50);
  };

  const handleSaveEdit = async () => {
    if (!editingMemoryId) return;
    try {
      const data = await apiFetch(`/api/soul/memories/${editingMemoryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent, category: editCategory, importance: editImportance }),
      });
      if (data.ok) {
        setEditingMemoryId(null);
        await Promise.all([fetchMemories(), fetchMemoryDocuments(), fetchMemoryEvents()]);
        showNotice('success', t('记忆已更新'));
      } else {
        showNotice('error', data.error || t('更新失败'));
      }
    } catch (err) { showNotice('error', String(err)); }
  };

  const handleDeleteSkill = async (skillId: string) => {
    try {
      const data = await apiFetch(`/api/soul/memory-skills/${skillId}`, { method: 'DELETE' });
      if (data.ok) { fetchMemorySkills(); showNotice('success', t('技能已删除')); }
    } catch (err) { showNotice('error', String(err)); }
  };

  const handleToggleSkillStatus = async (skill: MemorySkill) => {
    const newStatus = skill.status === 'active' ? 'retired' : 'active';
    try {
      const data = await apiFetch(`/api/soul/memory-skills/${skill.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (data.ok) { fetchMemorySkills(); showNotice('success', newStatus === 'active' ? t('技能已启用') : t('技能已停用')); }
    } catch (err) { showNotice('error', String(err)); }
  };

  const handleDeleteObservation = async (obsId: string) => {
    try {
      const data = await apiFetch(`/api/soul/observations/${obsId}`, { method: 'DELETE' });
      if (data.ok) { fetchObservations(); showNotice('success', t('观察已删除')); }
    } catch (err) { showNotice('error', String(err)); }
  };

  const handleUpdateInsightStatus = async (insightId: string, status: string) => {
    try {
      const data = await apiFetch(`/api/soul/insights/${insightId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (data.ok) { fetchInsights(); showNotice('success', t('偏好状态已更新')); }
    } catch (err) { showNotice('error', String(err)); }
  };

  const handleConsolidate = async () => {
    setConsolidating(true);
    try {
      const data = await apiFetch('/api/soul/consolidate', { method: 'POST' });
      if (data.ok) {
        await Promise.all([
          fetchMemories(), fetchObservations(),
          fetchInsights(), fetchConsolidationLogs(),
          fetchMemoryDocuments(), fetchMemoryEvents(),
        ]);
        showNotice('success', t('整合完成：提升 {{promoted}} 条，合并 {{merged}} 条', { promoted: data.log?.promoted ?? 0, merged: data.log?.merged ?? 0 }));
      }
    } catch (err) { showNotice('error', String(err)); }
    finally { setConsolidating(false); }
  };

  const handlePromoteObservation = async (obsId: string) => {
    setPromotingId(obsId);
    try {
      const data = await apiFetch(`/api/soul/observations/${obsId}/promote`, { method: 'POST' });
      if (data.ok) {
        await Promise.all([fetchMemories(), fetchObservations(), fetchMemoryDocuments(), fetchMemoryEvents()]);
        showNotice('success', t('观察已提升为持久记忆'));
      } else {
        showNotice('error', data.error || t('提升失败'));
      }
    } catch (err) { showNotice('error', String(err)); }
    finally { setPromotingId(null); }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const data = await apiFetch('/api/soul/export');
      if (data.ok) {
        const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `nanoclaw-soul-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showNotice('success', t('导出成功'));
      }
    } catch (err) { showNotice('error', String(err)); }
    finally { setExporting(false); }
  };

  const handleImport = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImporting(true);
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const importData = parsed.data ?? parsed;
        const data = await apiFetch('/api/soul/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: importData }),
        });
        if (data.ok) {
          await Promise.all([
            fetchSoul(), fetchMemories(), fetchObservations(), fetchInsights(),
            fetchMemoryDocuments(), fetchMemorySkills(), fetchMemoryEvents(),
          ]);
          showNotice('success', t('导入成功'));
        } else {
          showNotice('error', data.error || t('导入失败'));
        }
      } catch (err) { showNotice('error', t('导入失败: {{error}}', { error: String(err) })); }
      finally { setImporting(false); }
    };
    input.click();
  };

  const handleAddRule = () => {
    if (!newRuleText.trim()) return;
    setBehaviorRules((prev) => [
      ...prev,
      { id: `rule-${Date.now()}`, text: newRuleText.trim(), enabled: true },
    ]);
    setNewRuleText('');
  };

  const handleToggleRule = (ruleId: string) => {
    setBehaviorRules((prev) =>
      prev.map((r) => (r.id === ruleId ? { ...r, enabled: !r.enabled } : r)),
    );
  };

  const handleDeleteRule = (ruleId: string) => {
    setBehaviorRules((prev) => prev.filter((r) => r.id !== ruleId));
  };

  const handleMoveRule = (index: number, direction: 'up' | 'down') => {
    setBehaviorRules((prev) => {
      const arr = [...prev];
      const target = direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= arr.length) return prev;
      [arr[index], arr[target]] = [arr[target], arr[index]];
      return arr;
    });
  };

  const updateField = (field: keyof SoulConfig, value: unknown) => {
    setSoul((prev) => ({ ...prev, [field]: value }));
  };

  if (loading) {
    return (
      <div className="page-view soul-page">
        <div className="page-header"><div className="page-header-copy"><h2>{t('灵魂')}</h2></div></div>
        <div className="page-body soul-page-body">
          <p className="soul-loading-text">{t('加载中')}...</p>
        </div>
      </div>
    );
  }

  const filteredMemories = memories.filter((m) => {
    if (memoryTierFilter !== 'all' && m.tier !== memoryTierFilter) return false;
    if (memoryScopeFilter !== 'all' && m.scope !== memoryScopeFilter) return false;
    if (memoryCategoryFilter !== 'all' && m.category !== memoryCategoryFilter) return false;
    return true;
  });

  const memoryDocumentsByPath = new Map(
    memoryDocuments
      .filter((doc) => doc.path_ref)
      .map((doc) => [doc.path_ref as string, doc]),
  );
  const eventById = new Map(memoryEvents.map((event) => [event.id, event]));
  const lastRecallByMemoryId = new Map<string, MemoryEvent>();
  for (const event of memoryEvents) {
    if (event.action_type === 'RECALL' && event.target_type === 'user_memory' && event.target_id) {
      if (!lastRecallByMemoryId.has(event.target_id)) {
        lastRecallByMemoryId.set(event.target_id, event);
      }
    }
  }
  const focusedEvents = memoryEvents.filter((event) =>
    AUDIT_FOCUS_ACTIONS.includes(event.action_type),
  );
  const filteredEvents = auditActionFilter === 'all'
    ? focusedEvents
    : memoryEvents.filter((e) => e.action_type === auditActionFilter);

  return (
    <div className="page-view soul-page">
      <div className="page-header">
        <div className="page-header-copy">
          <h2>
            {soul.emoji_enabled && soul.emoji ? `${soul.emoji} ` : ''}{t('灵魂')}
          </h2>
          <p className="soul-header-subtitle">
            {t('定义你的 AI 助手个性、语调和记忆')}
          </p>
        </div>
        {surfaceMode === 'soul' && activeTab === 'persona' && (
          <div className="page-header-actions">
            {hasSoul && (
              <button className="btn btn-danger" onClick={handleDelete}>{t('删除灵魂')}</button>
            )}
            <button className="btn btn-primary" onClick={handleSave}>{hasSoul ? t('保存修改') : t('保存')}</button>
          </div>
        )}
        {surfaceMode === 'soul' && activeTab === 'advanced' && (
          <div className="page-header-actions">
            <button className="btn btn-primary" onClick={handleSave}>{hasSoul ? t('保存修改') : t('保存')}</button>
          </div>
        )}
      </div>

      {notice && (
        <div
          className={`soul-notice ${notice.tone === 'success' ? 'soul-notice--success' : 'soul-notice--error'}`}
        >
          {notice.text}
        </div>
      )}

      <div className="soul-surface-switch">
        <button
          type="button"
          className={`soul-surface-switch-btn${surfaceMode === 'soul' ? ' active' : ''}`}
          onClick={() => setSurfaceMode('soul')}
        >
          主灵魂
        </button>
        <button
          type="button"
          className={`soul-surface-switch-btn${surfaceMode === 'tavern' ? ' active' : ''}`}
          onClick={() => setSurfaceMode('tavern')}
        >
          酒馆人格
        </button>
      </div>

      {surfaceMode === 'tavern' ? <TavernPersonasPanel apiBase={apiBase} /> : null}

      {surfaceMode === 'soul' ? (
        <>
      {/* Tab Bar */}
      <div className="soul-tab-bar">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`soul-tab${activeTab === tab.id ? ' soul-tab-active' : ''}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="page-body soul-page-body">
        {/* ========== Tab 1: Persona ========== */}
        {activeTab === 'persona' && (
          <>
            {/* Presets */}
            <details className="soul-presets-fold">
              <summary className="soul-presets-fold-summary">
                <span className="soul-presets-fold-label">{t('快速选择预设人格')}</span>
                <span className="soul-presets-fold-count">{t('{{count}} 个预设', { count: presets.length })}</span>
              </summary>
              <div className="soul-presets-fold-body">
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    className="btn btn-secondary soul-preset-btn"
                    onClick={() => handleApplyPreset(preset.id)}
                    title={preset.description}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </details>

            {/* Form */}
            <section className="settings-section settings-general-panel">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('人格配置')}</div>
                <p className="settings-general-panel-copy">{t('定义 AI 的性格、语调和行为准则')}</p>
              </div>
              <div className="settings-subsection">
                <div className="soul-section-grid">
                  <label className="config-field soul-field-stack">
                    <span className="settings-summary-label">{t('名字')}</span>
                    <input type="text" placeholder={t('如: Luna, Neo, Sage')}
                      value={soul.name || ''} onChange={(e) => updateField('name', e.target.value)} />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span className="settings-summary-label">{t('怎么称呼你')}</span>
                    <input type="text" placeholder={t('如: 小明, 老板, 大佬')}
                      value={soul.user_nickname || ''} onChange={(e) => updateField('user_nickname', e.target.value)} />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span className="settings-summary-label">{t('类型')}</span>
                    <input type="text" placeholder={t('如: 温柔的猫型助手')}
                      value={soul.creature || ''} onChange={(e) => updateField('creature', e.target.value)} />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span className="settings-summary-label">{t('风格调性')}</span>
                    <input type="text" placeholder={t('如: 温暖、话多、爱开玩笑')}
                      value={soul.vibe || ''} onChange={(e) => updateField('vibe', e.target.value)} />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span className="settings-summary-label">{t('语调')}</span>
                    <NcSelect value={soul.tone || 'default'} onChange={(e) => updateField('tone', e.target.value)}>
                      {TONE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </NcSelect>
                  </label>
                  <label className="config-field soul-field-stack">
                    <span className="settings-summary-label">{t('偏好语言')}</span>
                    <input type="text" placeholder={t('如: 中文, English')}
                      value={soul.language_preference || ''}
                      onChange={(e) => updateField('language_preference', e.target.value)} />
                  </label>
                </div>

                {/* Emoji toggle + picker */}
                <div className="soul-emoji-row">
                  <NcCheckbox
                    className="settings-checkbox-field"
                    checked={!!soul.emoji_enabled}
                    onChange={(e) => updateField('emoji_enabled', e.target.checked ? 1 : 0)}
                    label={<span className="soul-checkbox-label-text">{t('启用 Emoji 表达')}</span>}
                  />
                  {!!soul.emoji_enabled && (
                    <input type="text" placeholder={t('代表符号 如: 🌙')}
                      className="soul-emoji-input"
                      value={soul.emoji || ''}
                      onChange={(e) => updateField('emoji', e.target.value)}
                    />
                  )}
                </div>

                <label className="config-field soul-field-stack soul-field-stack--mt16">
                  <span className="settings-summary-label">{t('人格描述')} (Soul Prompt)</span>
                  <textarea rows={5} placeholder={t('自由描述 AI 的性格、说话方式和行为准则...')}
                    className="soul-textarea-vertical"
                    value={soul.persona_prompt || ''}
                    onChange={(e) => updateField('persona_prompt', e.target.value)}
                  />
                </label>

                <label className="config-field soul-field-stack soul-field-stack--mt12">
                  <span className="settings-summary-label">{t('额外指令')}</span>
                  <textarea rows={3} placeholder={t('给 AI 的额外行为指令...')}
                    className="soul-textarea-vertical"
                    value={soul.extra_instructions || ''}
                    onChange={(e) => updateField('extra_instructions', e.target.value)}
                  />
                </label>

                <div className="soul-inline-checkboxes">
                  <NcCheckbox
                    className="settings-checkbox-field"
                    checked={soul.enabled !== 0}
                    onChange={(e) => updateField('enabled', e.target.checked ? 1 : 0)}
                    label={<span className="soul-checkbox-label-text">{t('启用灵魂')}</span>}
                  />
                  <NcCheckbox
                    className="settings-checkbox-field"
                    checked={!!soul.auto_evolve}
                    onChange={(e) => updateField('auto_evolve', e.target.checked ? 1 : 0)}
                    label={<span className="soul-checkbox-label-text">{t('允许 AI 自动学习进化')}</span>}
                  />
                </div>
              </div>
            </section>
          </>
        )}

        {/* ========== Tab 2: Memory ========== */}
        {activeTab === 'memory' && (
          <>
            {/* Add Memory */}
            <section className="settings-section settings-general-panel soul-panel-mb">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('新增记忆')}</div>
              </div>
              <div className="settings-subsection">
                <div className="soul-add-memory-row">
                  <label className="config-field soul-field-stack soul-field-fluid">
                    <span className="settings-summary-label">{t('内容')}</span>
                    <input type="text" placeholder={t('如: 我喜欢简洁的回答')}
                      value={newMemoryContent} onChange={(e) => setNewMemoryContent(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddMemory(); }} />
                  </label>
                  <label className="config-field soul-field-stack soul-field-narrow">
                    <span className="settings-summary-label">{t('分类')}</span>
                    <NcSelect value={newMemoryCategory} onChange={(e) => setNewMemoryCategory(e.target.value)}>
                      {CATEGORY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </NcSelect>
                  </label>
                  <label className="config-field soul-field-stack soul-field-narrow">
                    <span className="settings-summary-label">{t('重要度')}</span>
                    <input type="number" min={1} max={10} value={newMemoryImportance}
                      onChange={(e) => setNewMemoryImportance(parseInt(e.target.value, 10) || 5)} />
                  </label>
                  <button className="btn btn-primary" onClick={handleAddMemory}
                    disabled={!newMemoryContent.trim()}>{t('新增')}</button>
                </div>
              </div>
            </section>

            {/* Filters */}
            <div className="soul-memory-filters">
              <AppSelect
                value={memoryTierFilter}
                onChange={(v) => setMemoryTierFilter(v)}
                ariaLabel={t('按层级筛选')}
                options={[
                  { value: 'all', label: `${t('全部层级')} (${memories.length})` },
                  { value: 'core', label: `${t('核心')} (${memories.filter((m) => m.tier === 'core').length})` },
                  { value: 'durable', label: `${t('持久')} (${memories.filter((m) => m.tier === 'durable').length})` },
                ] as AppSelectOption[]}
              />
              <AppSelect
                value={memoryScopeFilter}
                onChange={(v) => setMemoryScopeFilter(v)}
                ariaLabel={t('按范围筛选')}
                options={[
                  { value: 'all', label: t('全部范围') },
                  { value: 'global', label: t('全局') },
                  { value: 'group', label: t('群组') },
                  { value: 'conversation', label: t('会话') },
                ] as AppSelectOption[]}
              />
              <AppSelect
                value={memoryCategoryFilter}
                onChange={(v) => setMemoryCategoryFilter(v)}
                ariaLabel={t('按分类筛选')}
                options={[{ value: 'all', label: t('全部分类') }, ...CATEGORY_OPTIONS] as AppSelectOption[]}
              />
              <span className="soul-memory-filter-count">
                {filteredMemories.length}/{memories.length} {t('条')}
              </span>
            </div>

            <TabBar tabs={memorySubTabs} activeKey={memorySubTab} onChange={(k) => setMemorySubTab(k as MemorySubTab)} size="small" />

            {/* Memories List */}
            {memorySubTab === 'memories' && (<>
            <section className="settings-section settings-general-panel soul-panel-mb">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('持久记忆')}</div>
                <p className="settings-general-panel-copy">{t('经过整合确认的记忆，AI 会在对话中参考')}</p>
              </div>
              <div className="settings-subsection">
                {filteredMemories.length === 0 ? (
                  <p className="soul-empty-hint">{t('暂无记忆')}</p>
                ) : (
                  <div className="soul-list-stack">
                    {filteredMemories.map((mem) => {
                      const projection = memoryDocumentsByPath.get(`user_memory:${mem.id}`);
                      const lastRecall = lastRecallByMemoryId.get(mem.id);
                      const sourceEvent = mem.source_event_id ? eventById.get(mem.source_event_id) : null;
                      const statusLabel = mem.valid_to
                        ? t('已截止')
                        : isExpired(mem.expires_at)
                          ? t('已过期')
                          : t('当前有效');
                      return (
                      <div key={mem.id} className="soul-surface-card">
                        <div className="soul-row-toolbar">
                          {badge(CATEGORY_OPTIONS.find((c) => c.value === mem.category)?.label || mem.category)}
                          {mem.tier === 'core' && badge(t('核心'), 'var(--accent-bg, #1a2a3a)')}
                          {badge(SCOPE_LABELS[mem.scope] || mem.scope)}
                          {badge(statusLabel, mem.valid_to || isExpired(mem.expires_at)
                            ? 'var(--error-bg, #3a1a1a)'
                            : 'var(--success-bg, #1a3a2a)')}
                          <span className="soul-flex-1">{mem.content}</span>
                          {mem.source && mem.source !== 'manual' && (
                            badge(SOURCE_LABELS[mem.source] || mem.source,
                              mem.source === 'llm_extract' ? 'var(--accent-bg, #1a2a3a)' : undefined)
                          )}
                          {confidenceBar(mem.confidence)}
                          <span className="soul-meta-11">
                            {mem.importance}/10
                          </span>
                          <button className="btn btn-sm btn-secondary soul-btn-compact" onClick={() => handleStartEdit(mem)}
                          >{t('编辑')}</button>
                          <button className="btn btn-sm btn-danger soul-btn-compact" onClick={() => handleDeleteMemory(mem.id)}
                          >{t('删除')}</button>
                        </div>
                        {/* Metadata row */}
                        <div className="soul-card-meta">
                          {projection
                            ? badge(t('已索引'), 'var(--success-bg, #1a3a2a)')
                            : badge(t('未索引'), 'var(--warning-bg, #3a2d1a)')}
                          <span>{t('来源')}: {SOURCE_LABELS[mem.source || 'manual'] || mem.source || t('手动')}</span>
                          <span>{t('范围')}: {SCOPE_LABELS[mem.scope] || mem.scope}</span>
                          <span>{t('分类')}: {CATEGORY_OPTIONS.find((c) => c.value === mem.category)?.label || mem.category}</span>
                          <span>{t('层级')}: {mem.tier}</span>
                          <span>{t('访问 {{count}} 次', { count: mem.access_count })}</span>
                          {mem.last_accessed_at && <span>{t('最近访问')}: {formatDateTime(mem.last_accessed_at)}</span>}
                          {lastRecall ? (
                            <button
                              type="button"
                              className="link-btn soul-link-btn"
                              onClick={() => {
                                setActiveTab('audit');
                                setExpandedEventId(lastRecall.id);
                              }}
                            >
                              {t('最近召回')}: {formatDateTime(lastRecall.created_at)}
                            </button>
                          ) : (
                            <span>{t('尚未召回')}</span>
                          )}
                          {mem.valid_from && <span>{t('生效')}: {formatDate(mem.valid_from)}</span>}
                          {mem.valid_to && <span>{t('截止')}: {formatDate(mem.valid_to)}</span>}
                          {mem.expires_at && <span>{t('过期')}: {formatDate(mem.expires_at)}</span>}
                          {mem.source_event_id && (
                            <button
                              type="button"
                              className="link-btn soul-link-btn"
                              onClick={() => {
                                setActiveTab('audit');
                                setExpandedEventId(mem.source_event_id);
                              }}
                            >
                              {sourceEvent?.action_type
                                ? t('来源事件') + `: ${ACTION_TYPE_LABELS[sourceEvent.action_type] || sourceEvent.action_type}`
                                : t('来源事件')}
                            </button>
                          )}
                          <span>{t('更新')}: {formatDate(mem.updated_at)}</span>
                        </div>
                        {/* Inline edit */}
                        {editingMemoryId === mem.id && (
                          <div className="soul-memory-edit-panel">
                            <textarea ref={editContentRef} rows={2} value={editContent}
                              className="soul-memory-edit-textarea"
                              onChange={(e) => setEditContent(e.target.value)}
                            />
                            <NcSelect value={editCategory} onChange={(e) => setEditCategory(e.target.value)}
                              className="soul-memory-edit-select">
                              {CATEGORY_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </NcSelect>
                            <input type="number" min={1} max={10} value={editImportance}
                              className="soul-memory-edit-number"
                              onChange={(e) => setEditImportance(parseInt(e.target.value, 10) || 5)}
                            />
                            <button className="btn btn-sm btn-primary soul-btn-compact-tight" onClick={handleSaveEdit}
                            >{t('保存')}</button>
                            <button className="btn btn-sm btn-secondary soul-btn-compact-tight" onClick={() => setEditingMemoryId(null)}
                            >{t('取消')}</button>
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            </>)}

            {/* Memory Documents */}
            {memorySubTab === 'documents' && (
            <section className="settings-section settings-general-panel soul-panel-mb">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('文件记忆')} ({memoryDocuments.length})</div>
                <p className="settings-general-panel-copy">
                  {t('来自 user_memories、MEMORY.md 和 identity 文档的检索投影')}
                </p>
              </div>
              <div className="settings-subsection">
                {memoryDocuments.length === 0 ? (
                  <p className="soul-empty-hint">{t('暂无文件记忆')}</p>
                ) : (
                  <div className="soul-list-stack">
                    {memoryDocuments.map((doc) => (
                      <div key={doc.doc_id} className="soul-surface-card">
                        <div
                          className="soul-row-toolbar soul-row-toolbar--pointer"
                          onClick={() => setExpandedDocId(expandedDocId === doc.doc_id ? null : doc.doc_id)}
                        >
                          <span className="soul-expand-chevron">
                            {expandedDocId === doc.doc_id ? '\u25BC' : '\u25B6'}
                          </span>
                          {badge(DOC_SOURCE_TYPE_LABELS[doc.source_type] || doc.source_type)}
                          {badge(SCOPE_LABELS[doc.scope] || doc.scope)}
                          <span className="soul-doc-path">
                            {doc.path_ref || doc.doc_id}
                          </span>
                          <span className="soul-doc-title-muted">
                            {doc.title || ''}
                          </span>
                          <span className="soul-doc-date">
                            {new Date(doc.updated_at).toLocaleDateString()}
                          </span>
                        </div>
                        {expandedDocId === doc.doc_id && (
                          <div className="soul-doc-expanded">
                            <pre className="soul-doc-pre">
                              {doc.body.length > 2000 ? doc.body.slice(0, 2000) + '\n...(truncated)' : doc.body}
                            </pre>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
            )}

            {/* Memory Skills */}
            {memorySubTab === 'skills' && (
            <section className="settings-section settings-general-panel">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('技能记忆')} ({memorySkills.length})</div>
                <p className="settings-general-panel-copy">
                  {t('可复用的操作流程，AI 会在匹配场景时自动调用')}
                </p>
              </div>
              <div className="settings-subsection">
                {memorySkills.length === 0 ? (
                  <p className="soul-empty-hint">{t('暂无技能记忆')}</p>
                ) : (
                  <div className="soul-list-stack soul-list-stack--gap6">
                    {memorySkills.map((skill) => (
                      <div
                        key={skill.id}
                        className="soul-skill-row"
                        style={{ opacity: skill.status === 'retired' ? 0.5 : 1 }}
                      >
                        {badge(skill.status === 'active' ? t('活跃') : skill.status === 'candidate' ? t('候选') : t('停用'),
                          skill.status === 'active' ? 'var(--success-bg, #1a3a2a)' : undefined)}
                        <span className="soul-skill-name">{skill.name}</span>
                        <span className="soul-skill-trigger">
                          {skill.trigger_pattern}
                        </span>
                        <span className="soul-skill-stats">
                          {skill.success_count}{t('成功')} / {skill.failure_count}{t('失败')}
                        </span>
                        <button className="btn btn-sm btn-secondary soul-btn-compact"
                          onClick={() => handleToggleSkillStatus(skill)}
                        >
                          {skill.status === 'active' ? t('停用') : t('启用')}
                        </button>
                        <button className="btn btn-sm btn-danger soul-btn-compact"
                          onClick={() => handleDeleteSkill(skill.id)}
                        >{t('删除')}</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
            )}
          </>
        )}

        {/* ========== Tab 3: Evolution ========== */}
        {activeTab === 'evolution' && (
          <>
            <section className="settings-section settings-general-panel soul-panel-mb">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('短期观察')} ({observations.length})</div>
                <p className="settings-general-panel-copy">
                  {t('从对话中提取的原始观察，达标后会被提升为持久记忆')}
                </p>
              </div>
              <div className="settings-subsection">
                {observations.length === 0 ? (
                  <p className="soul-empty-hint">{t('暂无观察数据')}</p>
                ) : (
                  <div className="soul-list-stack soul-list-stack--gap6">
                    {observations.map((obs) => (
                      <div
                        key={obs.id}
                        className="soul-obs-row"
                        style={{ opacity: obs.promoted_to ? 0.5 : 1 }}
                      >
                        {badge(
                          CATEGORY_OPTIONS.find((c) => c.value === obs.category)?.label || obs.category,
                        )}
                        <span className="soul-flex-1">{obs.content}</span>
                        {badge(t('不注入 prompt'), 'var(--bg-tertiary, #2a2a2a)')}
                        {obs.promoted_to && badge(t('已提升'), 'var(--success-bg, #1a3a2a)')}
                        {confidenceBar(obs.confidence)}
                        <span className="soul-meta-11 soul-meta-11--wrap">x{obs.frequency}</span>
                        <span className="soul-meta-11 soul-meta-11--wrap">{formatDate(obs.last_seen_at)}</span>
                        {!obs.promoted_to && (
                          <button className="btn btn-sm btn-primary soul-btn-compact"
                            onClick={() => handlePromoteObservation(obs.id)}
                            disabled={promotingId === obs.id}
                          >
                            {promotingId === obs.id ? '...' : t('提升')}
                          </button>
                        )}
                        <button className="btn btn-sm btn-danger soul-btn-compact" onClick={() => handleDeleteObservation(obs.id)}
                        >{t('删除')}</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Insights */}
            <section className="settings-section settings-general-panel soul-panel-mb">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('交互偏好洞察')} ({insights.length})</div>
                <p className="settings-general-panel-copy">
                  {t('通过对话学习到的用户偏好，你可以接受或拒绝')}
                </p>
              </div>
              <div className="settings-subsection">
                {insights.length === 0 ? (
                  <p className="soul-empty-hint">{t('还没有学习到交互偏好，继续对话后会自动提取')}</p>
                ) : (
                  <div className="soul-list-stack soul-list-stack--gap8">
                    {insights.map((ins) => (
                      <div
                        key={ins.id}
                        className={`soul-insight-row ${
                          ins.status === 'active'
                            ? 'soul-insight-row--active'
                            : ins.status === 'retired'
                              ? 'soul-insight-row--retired'
                              : ''
                        }`}
                      >
                        {badge(INSIGHT_TYPE_LABELS[ins.insight_type] || ins.insight_type)}
                        <span className="soul-flex-1">{ins.content}</span>
                        {badge(INSIGHT_STATUS_LABELS[ins.status] || ins.status,
                          ins.status === 'active' ? 'var(--success-bg, #1a3a2a)' : undefined)}
                        {confidenceBar(ins.confidence)}
                        <span className="soul-meta-11 soul-meta-11--wrap">
                          {ins.evidence_count}{t('次证据')}
                        </span>
                        <div className="soul-inline-actions">
                          {ins.status !== 'active' && (
                            <button className="btn btn-sm btn-primary soul-btn-compact"
                              onClick={() => handleUpdateInsightStatus(ins.id, 'active')}
                            >
                              {t('接受')}
                            </button>
                          )}
                          {ins.status !== 'retired' && (
                            <button className="btn btn-sm btn-secondary soul-btn-compact"
                              onClick={() => handleUpdateInsightStatus(ins.id, 'retired')}
                            >
                              {t('拒绝')}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Consolidation */}
            <section className="settings-section settings-general-panel">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('记忆整合')}</div>
                <p className="settings-general-panel-copy">
                  {t('整合会审查短期观察、提升达标记忆、合并重复、清理过期数据')}
                </p>
              </div>
              <div className="settings-subsection">
                <div className="soul-consolidate-block">
                  <button className="btn btn-primary" onClick={handleConsolidate}
                    disabled={consolidating}>
                    {consolidating ? t('整合中...') : t('手动触发整合')}
                  </button>
                </div>

                {consolidationLogs.length > 0 && (
                  <>
                    <div className="settings-section-kicker soul-subsection-kicker">{t('整合历史')}</div>
                    <div className="soul-list-stack soul-list-stack--gap6">
                      {consolidationLogs.slice(0, 10).map((log) => (
                        <div key={log.id} className="soul-log-row">
                          <span className="soul-log-time">
                            {new Date(log.created_at).toLocaleString()}
                          </span>
                          {badge(log.run_type === 'manual' ? t('手动') : t('自动'))}
                          <span>{t('提升')} {log.promoted}</span>
                          <span>{t('合并')} {log.merged}</span>
                          <span>{t('修剪')} {log.pruned}</span>
                          <span>{t('洞察')} {log.insights_generated}</span>
                          {log.duration_ms != null && (
                            <span className="soul-log-duration">{log.duration_ms}ms</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </section>
          </>
        )}

        {/* ========== Tab 4: Audit Log ========== */}
        {activeTab === 'audit' && (
          <>
            <section className="settings-section settings-general-panel soul-panel-mb">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('召回审计时间线')} ({filteredEvents.length})</div>
                <p className="settings-general-panel-copy">
                  {t('重点展示 RECALL / PROMOTE / SKIP / MERGE，展开后可查看注入 prompt 的内容和决策元数据')}
                </p>
              </div>
              <div className="settings-subsection">
                <div className="soul-audit-filter-row">
                  <span className="soul-audit-filter-label">{t('类型')}:</span>
                  {[
                    { value: 'all', label: t('重点') },
                    ...AUDIT_FOCUS_ACTIONS.map((key) => ({ value: key, label: ACTION_TYPE_LABELS[key] || key })),
                  ].map((opt) => (
                    <button key={opt.value}
                      className={`btn soul-audit-chip ${auditActionFilter === opt.value ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setAuditActionFilter(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {filteredEvents.length === 0 ? (
                  <p className="soul-empty-hint">{t('暂无事件记录')}</p>
                ) : (
                  <div className="soul-list-stack">
                    <Pagination page={auditPage} pageSize={AUDIT_PAGE_SIZE} total={filteredEvents.length} onPageChange={setAuditPage} />
                    {filteredEvents.slice((auditPage - 1) * AUDIT_PAGE_SIZE, auditPage * AUDIT_PAGE_SIZE).map((evt) => (
                      <div
                        key={evt.id}
                        className="soul-audit-event"
                        style={{
                          borderLeft: `3px solid ${ACTION_TYPE_COLORS[evt.action_type] || 'var(--bg-tertiary, #2a2a2a)'}`,
                        }}
                      >
                        <div
                          className="soul-row-toolbar soul-row-toolbar--sm soul-row-toolbar--pointer"
                          onClick={() => setExpandedEventId(expandedEventId === evt.id ? null : evt.id)}
                        >
                          <span className="soul-expand-chevron">
                            {expandedEventId === evt.id ? '\u25BC' : '\u25B6'}
                          </span>
                          {badge(ACTION_TYPE_LABELS[evt.action_type] || evt.action_type,
                            ACTION_TYPE_COLORS[evt.action_type])}
                          {badge(evt.target_type)}
                          <span className="soul-audit-reason">
                            {evt.decision_reason || ''}
                          </span>
                          {evt.target_id && (
                            <span className="soul-audit-target-id">
                              {evt.target_id}
                            </span>
                          )}
                          <span className="soul-audit-time">
                            {new Date(evt.created_at).toLocaleString()}
                          </span>
                        </div>
                        {expandedEventId === evt.id && (
                          <div className="soul-audit-detail">
                            <div className="soul-audit-snapshot-grid">
                              {evt.before_snapshot && (
                                <div>
                                  <div className="soul-audit-snapshot-label">{t('变更前')}</div>
                                  <pre className="soul-audit-snapshot-pre">
                                    {(() => { try { return JSON.stringify(JSON.parse(evt.before_snapshot), null, 2); } catch { return evt.before_snapshot; } })()}
                                  </pre>
                                </div>
                              )}
                              {evt.after_snapshot && (
                                <div>
                                  <div className="soul-audit-snapshot-label">{t('变更后')}</div>
                                  <pre className="soul-audit-snapshot-pre">
                                    {(() => { try { return JSON.stringify(JSON.parse(evt.after_snapshot), null, 2); } catch { return evt.after_snapshot; } })()}
                                  </pre>
                                </div>
                              )}
                            </div>
                            {evt.metadata_json && (
                              <div className="soul-audit-metadata">
                                <span className="soul-audit-metadata-label">{t('元数据')}: </span>
                                <span className="soul-audit-metadata-value">
                                  {evt.metadata_json}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </>
        )}

        {/* ========== Persona Advanced Controls ========== */}
        {activeTab === 'advanced' && (
          <>
            {/* Visual Behavior Rules Editor */}
            <section className="settings-section settings-general-panel soul-panel-mb">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('行为准则')}</div>
                <p className="settings-general-panel-copy">
                  {t('定义 AI 的行为规则，可排序、启用/禁用。保存后生效。')}
                </p>
              </div>
              <div className="settings-subsection">
                <div className="soul-rule-editor-row">
                  <input type="text" placeholder={t('输入新规则，如: 回复不超过3句话')}
                    className="soul-rule-input-grow"
                    value={newRuleText}
                    onChange={(e) => setNewRuleText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddRule(); }}
                  />
                  <button className="btn btn-primary" onClick={handleAddRule}
                    disabled={!newRuleText.trim()}>{t('新增')}</button>
                </div>
                {behaviorRules.length === 0 ? (
                  <p className="soul-empty-hint">
                    {t('暂无自定义规则，将使用默认行为准则')}
                  </p>
                ) : (
                  <div className="soul-list-stack">
                    {behaviorRules.map((rule, idx) => (
                      <div
                        key={rule.id}
                        className="soul-behavior-rule-row"
                        style={{ opacity: rule.enabled ? 1 : 0.5 }}
                      >
                        <div className="soul-rule-order-stack">
                          <button
                            type="button"
                            className="soul-rule-move-btn"
                            onClick={() => handleMoveRule(idx, 'up')}
                            disabled={idx === 0}
                          >
                            &#9650;
                          </button>
                          <button
                            type="button"
                            className="soul-rule-move-btn"
                            onClick={() => handleMoveRule(idx, 'down')}
                            disabled={idx === behaviorRules.length - 1}
                          >
                            &#9660;
                          </button>
                        </div>
                        <span className="soul-rule-index">
                          {idx + 1}
                        </span>
                        <NcCheckbox
                          checked={rule.enabled}
                          onChange={() => handleToggleRule(rule.id)}
                        />
                        <span className={`soul-rule-text ${rule.enabled ? '' : 'soul-rule-text--disabled'}`}>{rule.text}</span>
                        <button className="btn btn-sm btn-danger soul-btn-compact"
                          onClick={() => handleDeleteRule(rule.id)}
                        >
                          {t('删除')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Consolidation Thresholds */}
            <section className="settings-section settings-general-panel soul-panel-mb">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('整合阈值配置')}</div>
                <p className="settings-general-panel-copy">
                  {t('调整记忆整合的触发条件。保存后生效。')}
                </p>
              </div>
              <div className="settings-subsection">
                <div className="soul-form-grid-2">
                  <label className="config-field soul-field-stack">
                    <span className="settings-summary-label">
                      {t('最低频率')} ({t('观察被提升的最低出现次数')})
                    </span>
                    <input type="number" min={1} max={20} step={1}
                      value={consolidationCfg.minFrequency}
                      onChange={(e) => setConsolidationCfg((c) => ({
                        ...c, minFrequency: parseInt(e.target.value, 10) || 2,
                      }))} />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span className="settings-summary-label">
                      {t('最低置信度')} ({t('观察被提升的最低置信度')})
                    </span>
                    <input type="number" min={0} max={1} step={0.05}
                      value={consolidationCfg.minConfidence}
                      onChange={(e) => setConsolidationCfg((c) => ({
                        ...c, minConfidence: parseFloat(e.target.value) || 0.5,
                      }))} />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span className="settings-summary-label">
                      {t('洞察激活阈值')} ({t('偏好洞察自动启用的置信度')})
                    </span>
                    <input type="number" min={0} max={1} step={0.05}
                      value={consolidationCfg.insightActivation}
                      onChange={(e) => setConsolidationCfg((c) => ({
                        ...c, insightActivation: parseFloat(e.target.value) || 0.6,
                      }))} />
                  </label>
                  <label className="config-field soul-field-stack">
                    <span className="settings-summary-label">
                      {t('冷却时间')} ({t('自动整合的间隔小时数')})
                    </span>
                    <input type="number" min={1} max={168} step={1}
                      value={consolidationCfg.cooldownHours}
                      onChange={(e) => setConsolidationCfg((c) => ({
                        ...c, cooldownHours: parseInt(e.target.value, 10) || 24,
                      }))} />
                  </label>
                </div>
                <button className="btn btn-secondary soul-reset-defaults-btn"
                  onClick={() => setConsolidationCfg({ ...DEFAULT_CONSOLIDATION })}>
                  {t('恢复默认值')}
                </button>
              </div>
            </section>

            {/* Stats Overview */}
            <section className="settings-section settings-general-panel soul-panel-mb">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('统计概览')}</div>
              </div>
              <div className="settings-subsection">
                <div className="soul-stats-grid">
                  {[
                    { label: t('持久记忆'), value: memories.length },
                    { label: t('核心记忆'), value: memories.filter((m) => m.tier === 'core').length },
                    { label: t('短期观察'), value: observations.length },
                    { label: t('已提升'), value: observations.filter((o) => o.promoted_to).length },
                    { label: t('活跃洞察'), value: insights.filter((i) => i.status === 'active').length },
                    { label: t('待确认'), value: insights.filter((i) => i.status === 'candidate').length },
                    { label: t('整合次数'), value: consolidationLogs.length },
                  ].map((stat) => (
                    <div key={stat.label} className="soul-stat-card">
                      <div className="soul-stat-value">
                        {stat.value}
                      </div>
                      <div className="soul-stat-label">{stat.label}</div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Export / Import */}
            <section className="settings-section settings-general-panel">
              <div className="settings-general-panel-header">
                <div className="settings-section-kicker">{t('数据管理')}</div>
                <p className="settings-general-panel-copy">
                  {t('导出灵魂配置、记忆、观察和偏好的完整备份')}
                </p>
              </div>
              <div className="settings-subsection">
                <div className="soul-data-actions">
                  <button className="btn btn-primary" onClick={handleExport}
                    disabled={exporting}>
                    {exporting ? t('导出中...') : t('导出全部数据')}
                  </button>
                  <button className="btn btn-secondary" onClick={handleImport}
                    disabled={importing}>
                    {importing ? t('导入中...') : t('导入灵魂配置')}
                  </button>
                </div>
                <p className="soul-data-hint">
                  {soul.auto_evolve ? t('AI自动学习功能已启用') : t('AI自动学习功能已关闭')}
                  {!soul.auto_evolve && ` ${t('启用后 AI 会从对话中学习交互偏好。')}`}
                </p>
              </div>
            </section>
          </>
        )}
      </div>
        </>
      ) : null}
    </div>
  );
}
