import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { KbGraphLink, KbGraphNode } from '../components/KnowledgeGraph';
import type {
  KnowledgeGraphHiddenCounts,
  KnowledgeGraphStats,
} from '../components/KnowledgeGraph';
import {
  AppHeroHeader,
  LibraryCard,
  SearchPill,
} from '../components/common';
import { Pagination } from '../components/common/Pagination';
import { NcSelect } from '../components/common/NcSelect';
import { NcCheckbox } from '../components/common/NcCheckbox';
import { NcToggle } from '../components/common/NcToggle';
import { TabBar } from '../components/common/TabBar';
import { IconSearch, IconX } from '../components/AppIcons';
import { AppSelect, type AppSelectOption } from '../components/AppSelect';
import { useLocation, useNavigate } from 'react-router-dom';
import type {
  AiProvider,
  KnowledgeBase,
  KnowledgeEnhancementLevel,
} from '../app-types';
import { createMarkdownHeadingId } from '../markdown-helpers';
import '../styles/knowledge.css';

const KnowledgeGraph = lazy(() =>
  import('../components/KnowledgeGraph').then((m) => ({
    default: m.KnowledgeGraph,
  })),
);
const MarkdownContent = lazy(() =>
  import('../components/MarkdownContent').then((m) => ({
    default: m.MarkdownContent,
  })),
);

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
  '.log',
  '.yml',
  '.yaml',
  '.xml',
  '.html',
  '.htm',
]);

const BINARY_EXTENSIONS = new Set(['.pdf', '.docx']);

interface KbLimits {
  maxFileSizeMb: number;
  maxZipSizeMb: number;
  maxZipFiles: number;
  maxImportPages: number;
  maxCrawlDepth: number;
}

const DEFAULT_LIMITS: KbLimits = {
  maxFileSizeMb: 10,
  maxZipSizeMb: 50,
  maxZipFiles: 200,
  maxImportPages: 500,
  maxCrawlDepth: 3,
};

export interface KnowledgePageProps {
  apiBase: string;
}

const DOCS_PAGE_SIZE = 15;

function getCategoryLabels(t: (key: string) => string): Record<string, string> {
  return {
    general: t('通用'),
    faq: t('常见问题'),
    docs: t('产品文档'),
    policy: t('规章制度'),
    support: t('售后支持'),
    training: t('培训素材'),
    other: t('其他'),
  };
}

function getKbEnhancementOptions(
  t: (key: string) => string,
): AppSelectOption[] {
  return [
    { value: 'metadata', label: t('元数据增强') },
    { value: 'wiki_lite', label: t('LLM 精简') },
    { value: 'wiki_full', label: t('LLM 完整') },
  ];
}

function getKbVisibilityOptions(t: (key: string) => string): AppSelectOption[] {
  return [
    { value: 'private', label: t('私有') },
    { value: 'shared', label: t('共享') },
  ];
}

interface KnowledgeDocument {
  id: string;
  kb_id: string;
  filename: string;
  content_type: string;
  content_hash: string;
  char_count: number;
  chunk_count: number;
  status: string;
  error_message: string | null;
  source_url: string | null;
  published_at: string | null;
  doc_path: string | null;
  superseded_by: string | null;
  llm_status: string | null;
  created_at: string;
  updated_at: string;
}

interface KnowledgeTreeRow {
  id: string;
  filename: string;
  doc_path: string | null;
  depth: number;
  parent_doc_id: string | null;
  published_at: string | null;
  superseded_by: string | null;
  status: string;
  llm_status: string | null;
}

interface KnowledgeWikiListRow {
  id: string;
  kb_id: string;
  page_type: string;
  title: string;
  version: number;
  edited_by_human?: number;
  edited_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface KnowledgeProcessingStatus {
  run_id: string | null;
  run_mode: string | null;
  concurrency_used: number | null;
  started_at: string | null;
  finished_at: string | null;
  eligible_total: number;
  pending: number;
  queued: number;
  processing: number;
  active_total: number;
  wiki_processing: number;
  done: number;
  failed: number;
  processed_total: number;
  progress_percent: number;
  stage:
    | 'idle'
    | 'llm_processing'
    | 'wiki_building'
    | 'completed'
    | 'partial_failed';
  active_docs: Array<{
    id: string;
    filename: string;
    llm_status: string;
    updated_at: string;
  }>;
  last_lint: {
    ran_at: string;
    orphan_count: number;
    stale_count: number;
    missing_count: number;
    contradiction_count: number;
    human_locked_count: number;
  } | null;
}

interface KnowledgeRelationRow {
  id: string;
  source_doc_id: string;
  target_doc_id: string;
  relation_type: string;
  confidence: number;
  detail: string | null;
  created_at: string;
}

interface KnowledgeChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  created_at: string;
}

interface SearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  chunkIndex: number;
  filename?: string;
  kbName?: string;
  docPath?: string | null;
  publishedAt?: string | null;
  docSummary?: string | null;
  parentSummary?: string | null;
  enhancementLevel?: string;
}

interface WikiResult {
  pageId: string;
  kbId: string;
  title: string;
  content: string;
  pageType: string;
  score: number;
  updatedAt: string;
  sourceDocIds: string[];
  isStale: boolean;
  evidenceChunks: Array<{
    chunkId: string;
    documentId: string;
    filename?: string;
    kbName?: string;
    content: string;
    chunkIndex: number;
    score: number;
  }>;
  claimEvidence?: Array<{
    claimId: string;
    claimText: string;
    confidence: number;
    chunkId: string | null;
    documentId: string | null;
    filename?: string;
    content?: string;
  }>;
}

interface KnowledgeWikiEvidence {
  chunkId: string;
  documentId: string;
  filename: string | null;
  docPath: string | null;
  chunkIndex: number;
  content: string;
}

interface KnowledgeWikiClaim {
  id: string;
  page_id: string;
  claim_text: string;
  source_doc_id: string | null;
  evidence_chunk_id: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
  evidence: KnowledgeWikiEvidence | null;
}

interface KnowledgeWikiDetail extends Record<string, unknown> {
  id: string;
  kb_id: string;
  page_type: string;
  title: string;
  content: string;
  source_doc_ids?: string | null;
  version: number;
  edited_by_human?: number;
  edited_at?: string | null;
  updated_at: string;
  claims?: KnowledgeWikiClaim[];
}

interface KnowledgeGraphResponse {
  nodes: KbGraphNode[];
  links: KbGraphLink[];
  stats?: KnowledgeGraphStats;
  hidden_counts?: KnowledgeGraphHiddenCounts;
  truncated?: boolean;
}

type KnowledgeGraphViewMode = 'overview' | 'focus' | 'full';

type KnowledgeWorkbenchTab =
  | 'overview'
  | 'content'
  | 'graph'
  | 'settings'
  | 'search';

type KnowledgeContentView = 'docs' | 'tree' | 'wiki';

function getStatusLabels(t: (key: string) => string): Record<string, string> {
  return {
    pending: t('等待处理'),
    indexing: t('索引中'),
    indexed: t('已索引'),
    failed: t('失败'),
  };
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function getDocumentStatusClass(status: string): string {
  if (status === 'indexed') return 'is-indexed';
  if (status === 'indexing') return 'is-indexing';
  if (status === 'failed') return 'is-failed';
  return '';
}

function getEnhancementLevelLabels(
  t: (key: string) => string,
): Record<KnowledgeEnhancementLevel, string> {
  return {
    metadata: t('元数据增强'),
    wiki_lite: t('LLM 精简'),
    wiki_full: t('LLM 完整'),
  };
}

function kbEnhancementLevel(
  kb: KnowledgeBase | null | undefined,
): KnowledgeEnhancementLevel {
  const v = kb?.enhancement_level;
  if (v === 'wiki_lite' || v === 'wiki_full' || v === 'metadata') return v;
  return 'metadata';
}

function publishedDateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateInputToIso(dateStr: string): string | null {
  const t = dateStr.trim();
  if (!t) return null;
  const d = new Date(`${t}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function docPathBreadcrumb(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts.join(' › ') : null;
}

function buildSearchBackfillMarkdown(
  query: string,
  wiki: WikiResult[],
  chunks: SearchResult[],
  t: (key: string) => string,
): string {
  const parts: string[] = [`## ${t('检索问题')}\n\n${query}\n`];
  if (wiki.length > 0) {
    parts.push(`## ${t('Wiki 命中摘录')}\n`);
    for (const w of wiki) {
      parts.push(`### ${w.title}\n\n${w.content}\n`);
      if (w.evidenceChunks.length > 0) {
        parts.push(`#### ${t('关联证据')}\n`);
        for (const evidence of w.evidenceChunks) {
          const source = [evidence.kbName, evidence.filename]
            .filter(Boolean)
            .join(' · ');
          parts.push(
            `- ${source || evidence.documentId} #${evidence.chunkIndex + 1}\n\n${evidence.content}\n`,
          );
        }
      }
    }
  }
  if (chunks.length > 0) {
    parts.push(`## ${t('文档片段摘录')}\n`);
    for (const c of chunks) {
      const head = [c.filename, c.kbName].filter(Boolean).join(' · ');
      parts.push(`### ${head || t('片段')}\n\n${c.content}\n`);
    }
  }
  return parts.join('\n');
}

function parseWikiSourceDocIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function extractMarkdownHeadings(
  content: string,
): Array<{ id: string; text: string; level: number }> {
  let headingIndex = 0;
  return content
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(#{2,3})\s+(.+)$/);
      if (!match) return null;
      const text = match[2].trim();
      return {
        id: createMarkdownHeadingId('knowledge-wiki', headingIndex++, text),
        level: match[1].length,
        text,
      };
    })
    .filter(
      (item): item is { id: string; text: string; level: number } =>
        item !== null,
    );
}

function parseWikiSearchRow(r: Record<string, unknown>): WikiResult | null {
  const pageId = String(r.pageId ?? r.page_id ?? '');
  if (!pageId) return null;
  const src = r.sourceDocIds ?? r.source_doc_ids;
  const sourceDocIds = Array.isArray(src) ? src.map((x) => String(x)) : [];
  return {
    pageId,
    kbId: String(r.kbId ?? r.kb_id ?? ''),
    title: String(r.title ?? ''),
    content: String(r.content ?? ''),
    pageType: String(r.pageType ?? r.page_type ?? ''),
    score: Number(r.score ?? 0),
    updatedAt: String(r.updatedAt ?? r.updated_at ?? ''),
    sourceDocIds,
    isStale: Boolean(r.isStale ?? r.is_stale),
    evidenceChunks: Array.isArray(r.evidenceChunks)
      ? r.evidenceChunks
          .filter(
            (entry): entry is Record<string, unknown> =>
              Boolean(entry) && typeof entry === 'object',
          )
          .map((entry) => ({
            chunkId: String(entry.chunkId ?? ''),
            documentId: String(entry.documentId ?? ''),
            filename:
              entry.filename != null ? String(entry.filename) : undefined,
            kbName: entry.kbName != null ? String(entry.kbName) : undefined,
            content: String(entry.content ?? ''),
            chunkIndex: Number.isFinite(Number(entry.chunkIndex))
              ? Number(entry.chunkIndex)
              : 0,
            score: Number.isFinite(Number(entry.score))
              ? Number(entry.score)
              : 0,
          }))
      : [],
    claimEvidence: Array.isArray(r.claimEvidence)
      ? r.claimEvidence
          .filter(
            (entry): entry is Record<string, unknown> =>
              Boolean(entry) && typeof entry === 'object',
          )
          .map((entry) => ({
            claimId: String(entry.claimId ?? ''),
            claimText: String(entry.claimText ?? ''),
            confidence: Number.isFinite(Number(entry.confidence))
              ? Number(entry.confidence)
              : 0,
            chunkId: entry.chunkId == null ? null : String(entry.chunkId),
            documentId:
              entry.documentId == null ? null : String(entry.documentId),
            filename:
              entry.filename != null ? String(entry.filename) : undefined,
            content: entry.content != null ? String(entry.content) : undefined,
          }))
      : [],
  };
}

function getLlmStatusLabel(status: string, t: (key: string) => string): string {
  if (status === 'pending') return t('待处理');
  if (status === 'processing') return t('处理中');
  if (status === 'done') return t('已完成');
  if (status === 'failed') return t('失败');
  return status;
}

function getRelationTypeLabel(key: string, t: (key: string) => string): string {
  const map: Record<string, string> = {
    supersedes: t('替代'),
    supplements: t('补充'),
    contradicts: t('矛盾'),
    references: t('引用'),
    parent_of: t('父子'),
    wiki_source: t('Wiki 来源'),
  };
  return map[key] || key;
}

function getWikiPageTypeLabel(key: string, t: (key: string) => string): string {
  const map: Record<string, string> = {
    overview: t('总览'),
    entity: t('实体'),
    concept: t('概念'),
    synthesis: t('综合'),
    comparison: t('对比'),
  };
  return map[key] || key;
}

function getRecommendedGraphSettings(view: KnowledgeGraphViewMode): {
  maxNodes: number;
  minConfidence: number;
} {
  if (view === 'focus') {
    return { maxNodes: 180, minConfidence: 0.35 };
  }
  if (view === 'full') {
    return { maxNodes: 500, minConfidence: 0 };
  }
  return { maxNodes: 120, minConfidence: 0.7 };
}

const RELATION_GRAPH_LINK_TYPES = [
  'parent_of',
  'supersedes',
  'supplements',
  'contradicts',
  'references',
  'wiki_source',
] as const;

const VALID_DRAWER_TABS: ReadonlySet<string> = new Set([
  'overview',
  'docs',
  'search',
  'config',
  'tree',
  'relations',
  'wiki',
]);

const VALID_WORKBENCH_TABS: ReadonlySet<string> = new Set([
  'overview',
  'content',
  'graph',
  'settings',
  'search',
]);

const VALID_CONTENT_VIEWS: ReadonlySet<string> = new Set([
  'docs',
  'tree',
  'wiki',
]);

export function KnowledgePage({ apiBase }: KnowledgePageProps) {
  const { t } = useTranslation('knowledge');
  const CATEGORY_LABELS = useMemo(() => getCategoryLabels(t), [t]);
  const KB_ENHANCEMENT_OPTIONS = useMemo(() => getKbEnhancementOptions(t), [t]);
  const KB_VISIBILITY_OPTIONS = useMemo(() => getKbVisibilityOptions(t), [t]);
  const STATUS_LABELS = useMemo(() => getStatusLabels(t), [t]);
  const ENHANCEMENT_LEVEL_LABELS = useMemo(
    () => getEnhancementLevelLabels(t),
    [t],
  );
  const relationTypeCn = useCallback(
    (key: string) => getRelationTypeLabel(key, t),
    [t],
  );
  const wikiPageTypeLabel = useCallback(
    (key: string) => getWikiPageTypeLabel(key, t),
    [t],
  );
  const renderKnowledgeLlmBadge = useCallback(
    (status: string | null | undefined) => {
      if (!status) return null;
      return (
        <span className={`knowledge-llm-badge ${status}`}>
          {getLlmStatusLabel(status, t)}
        </span>
      );
    },
    [t],
  );
  const location = useLocation();
  const navigate = useNavigate();

  const urlParams = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );
  const urlKb = urlParams.get('kb');
  const urlTab = urlParams.get('tab');
  const urlContent = urlParams.get('content');
  const urlView = urlParams.get('view');

  const setUrlState = useCallback(
    (params: Record<string, string | null>) => {
      const next = new URLSearchParams(location.search);
      for (const [k, v] of Object.entries(params)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      navigate(
        { pathname: location.pathname, search: qs ? `?${qs}` : '' },
        { replace: true },
      );
    },
    [location.search, location.pathname, navigate],
  );

  const [limits, setLimits] = useState<KbLimits>(DEFAULT_LIMITS);

  const drawerOpen = Boolean(
    urlKb || urlView === 'create' || urlView === 'search',
  );
  const creatingKb = urlView === 'create';
  const [kbFilter, setKbFilter] = useState('');
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedKbId, setSelectedKbId] = useState<string | null>(urlKb);
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [docsPage, setDocsPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [newKbName, setNewKbName] = useState('');
  const [newKbDesc, setNewKbDesc] = useState('');
  const [newKbCategory, setNewKbCategory] = useState('general');
  const [newKbVisibility, setNewKbVisibility] = useState<'private' | 'shared'>(
    'private',
  );
  const [chunkSize, setChunkSize] = useState(300);
  const [chunkOverlap, setChunkOverlap] = useState(60);
  const [cleanupPatterns, setCleanupPatterns] = useState('');
  const [newKbEmbeddingProviderId, setNewKbEmbeddingProviderId] = useState('');
  const [editingKb, setEditingKb] = useState<KnowledgeBase | null>(null);
  const [embeddingProviders, setEmbeddingProviders] = useState<AiProvider[]>(
    [],
  );
  const [llmProviders, setLlmProviders] = useState<AiProvider[]>([]);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [wikiResults, setWikiResults] = useState<WikiResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [flashDocId, setFlashDocId] = useState<string | null>(null);

  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadContent, setUploadContent] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [importUrl, setImportUrl] = useState('');
  const [importDepth, setImportDepth] = useState(0);
  const [importMaxPages, setImportMaxPages] = useState(50);
  const [importForce, setImportForce] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    total: number;
    success: number;
    failed: number;
    skipped?: number;
  } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    onConfirm: (() => void) | null;
  }>({ open: false, title: '', message: '', onConfirm: null });
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [docChunks, setDocChunks] = useState<KnowledgeChunk[]>([]);
  const [loadingChunks, setLoadingChunks] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [rebuildingFts, setRebuildingFts] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [recleaning, setRecleaning] = useState(false);
  const [maintenanceMsg, setMaintenanceMsg] = useState<string | null>(null);

  const [newKbEnhancementLevel, setNewKbEnhancementLevel] =
    useState<KnowledgeEnhancementLevel>('metadata');
  const [newKbLlmProviderId, setNewKbLlmProviderId] = useState('');
  const [newKbTemporalHalfLifeDays, setNewKbTemporalHalfLifeDays] =
    useState(365);
  const [newKbAllowQueryBackfill, setNewKbAllowQueryBackfill] = useState(false);
  const [backfillSaving, setBackfillSaving] = useState(false);

  const [treeRows, setTreeRows] = useState<KnowledgeTreeRow[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [relations, setRelations] = useState<KnowledgeRelationRow[]>([]);
  const [relationsLoading, setRelationsLoading] = useState(false);
  const [relationsPresentation, setRelationsPresentation] = useState<
    'graph' | 'table'
  >('graph');
  const [kbGraphRaw, setKbGraphRaw] = useState<KnowledgeGraphResponse | null>(
    null,
  );
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphViewMode, setGraphViewMode] =
    useState<KnowledgeGraphViewMode>('overview');
  const [graphUseRecommendedPreset, setGraphUseRecommendedPreset] =
    useState(true);
  const [graphMaxNodes, setGraphMaxNodes] = useState(160);
  const [graphInclude, setGraphInclude] = useState<Set<string>>(
    () => new Set(['tree', 'relations', 'wiki_source']),
  );
  const [graphFocusId, setGraphFocusId] = useState('');
  const [graphTypeFilter, setGraphTypeFilter] = useState<Set<string>>(
    () => new Set(RELATION_GRAPH_LINK_TYPES),
  );
  const [graphMinConfidence, setGraphMinConfidence] = useState(0.7);
  const [showUnprocessedGraphNodes, setShowUnprocessedGraphNodes] =
    useState(false);
  const [wikiPages, setWikiPages] = useState<KnowledgeWikiListRow[]>([]);
  const [wikiSearch, setWikiSearch] = useState('');
  const [wikiTypeFilter, setWikiTypeFilter] = useState('all');
  const [wikiLoading, setWikiLoading] = useState(false);
  const [wikiDetail, setWikiDetail] = useState<KnowledgeWikiDetail | null>(
    null,
  );
  const [wikiDetailLoading, setWikiDetailLoading] = useState(false);
  const [wikiEditing, setWikiEditing] = useState(false);
  const [wikiDraftTitle, setWikiDraftTitle] = useState('');
  const [wikiDraftContent, setWikiDraftContent] = useState('');
  const [wikiSaving, setWikiSaving] = useState(false);
  const [wikiEditError, setWikiEditError] = useState<string | null>(null);
  const [wikiConflictVersion, setWikiConflictVersion] = useState<number | null>(
    null,
  );
  const [llmProcessing, setLlmProcessing] = useState(false);
  const [wikiLinting, setWikiLinting] = useState(false);
  const [processingStatus, setProcessingStatus] =
    useState<KnowledgeProcessingStatus | null>(null);
  const [globalLlmConcurrency, setGlobalLlmConcurrency] = useState('4');
  const [savingLlmConcurrency, setSavingLlmConcurrency] = useState(false);
  const [graphFullscreen, setGraphFullscreen] = useState(false);

  const selectedKb = useMemo(
    () =>
      selectedKbId
        ? (bases.find((base) => base.id === selectedKbId) ?? null)
        : null,
    [bases, selectedKbId],
  );

  useEffect(() => {
    if (creatingKb || !selectedKb) return;
    setEditingKb((prev) =>
      prev && prev.id === selectedKb.id ? prev : { ...selectedKb },
    );
  }, [creatingKb, selectedKb]);

  const graphRecommendedSettings = useMemo(
    () => getRecommendedGraphSettings(graphViewMode),
    [graphViewMode],
  );
  const selectedKbLevel = kbEnhancementLevel(selectedKb);
  const contentViewOptions = useMemo(
    () => [
      { key: 'docs' as const, label: t('文档') },
      ...(selectedKbLevel !== 'metadata' || docs.some((doc) => doc.doc_path)
        ? [{ key: 'tree' as const, label: t('文档树') }]
        : []),
      ...(selectedKbLevel === 'wiki_full'
        ? [{ key: 'wiki' as const, label: t('Wiki 页面') }]
        : []),
    ],
    [docs, selectedKbLevel, t],
  );
  const setDetailTab = useCallback(
    (tab: KnowledgeWorkbenchTab) => {
      if (tab === 'search') {
        setUrlState({ kb: null, tab: 'search', content: null, view: 'search' });
        return;
      }
      setUrlState({
        tab,
        content:
          tab === 'content'
            ? (urlContent && VALID_CONTENT_VIEWS.has(urlContent)
              ? (urlContent as KnowledgeContentView)
              : 'docs')
            : null,
        view: null,
      });
    },
    [setUrlState, urlContent],
  );
  const setContentTab = useCallback(
    (next: KnowledgeContentView) => {
      setUrlState({ tab: 'content', content: next, view: null });
    },
    [setUrlState],
  );
  const embeddingProviderLabelById = useMemo(
    () =>
      new Map(
        embeddingProviders.map((provider) => [
          provider.id,
          `${provider.alias}${provider.model ? ` · ${provider.model}` : ''}`,
        ]),
      ),
    [embeddingProviders],
  );
  const llmProviderLabelById = useMemo(
    () =>
      new Map(
        llmProviders.map((provider) => [
          provider.id,
          `${provider.alias}${provider.model ? ` · ${provider.model}` : ''}`,
        ]),
      ),
    [llmProviders],
  );
  const embeddingProviderOptions = useMemo<AppSelectOption[]>(
    () => [
      { value: '', label: t('仅全文检索（FTS）') },
      ...embeddingProviders.map((provider) => ({
        value: provider.id,
        label:
          `${provider.alias}${provider.model ? ` · ${provider.model}` : ''}` +
          `${provider.source === 'shared' ? ` · ${t('分享')}` : provider.source === 'system' ? ` · ${t('系统')}` : ''}`,
      })),
    ],
    [embeddingProviders],
  );
  const llmProviderOptions = useMemo<AppSelectOption[]>(
    () => [
      { value: '', label: t('请选择') },
      ...llmProviders.map((provider) => ({
        value: provider.id,
        label:
          `${provider.alias}${provider.model ? ` · ${provider.model}` : ''}` +
          `${provider.source === 'shared' ? ` · ${t('分享')}` : provider.source === 'system' ? ` · ${t('系统')}` : ''}`,
      })),
    ],
    [llmProviders],
  );
  const kbCategoryOptions = useMemo<AppSelectOption[]>(
    () =>
      Object.entries(CATEGORY_LABELS).map(([value, label]) => ({
        value,
        label,
      })),
    [],
  );

  const detailTab: KnowledgeWorkbenchTab = useMemo(() => {
    if (creatingKb) return 'settings';
    if (!selectedKb && urlView === 'search') return 'search';
    if (!selectedKb) return 'overview';

    const fromUrl = urlTab && VALID_DRAWER_TABS.has(urlTab) ? urlTab : 'overview';
    if (fromUrl === 'docs' || fromUrl === 'tree' || fromUrl === 'wiki') return 'content';
    if (fromUrl === 'relations') return 'graph';
    if (fromUrl === 'config') return 'settings';
    if (VALID_WORKBENCH_TABS.has(fromUrl)) return fromUrl as KnowledgeWorkbenchTab;
    return 'overview';
  }, [creatingKb, selectedKb, urlTab, urlView]);

  const contentView: KnowledgeContentView = useMemo(() => {
    const fromContent =
      urlContent && VALID_CONTENT_VIEWS.has(urlContent)
        ? (urlContent as KnowledgeContentView)
        : null;
    if (fromContent) return fromContent;
    if (urlTab === 'tree') return 'tree';
    if (urlTab === 'wiki') return 'wiki';
    return 'docs';
  }, [urlContent, urlTab]);

  const drawerTab = useMemo(() => {
    if (creatingKb) return 'config';
    if (!selectedKb && urlView === 'search') return 'search';
    if (detailTab === 'content') return contentView;
    if (detailTab === 'graph') return 'relations';
    if (detailTab === 'settings') return 'config';
    return detailTab;
  }, [contentView, creatingKb, detailTab, selectedKb, urlView]);

  const fetchBases = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/user/knowledge-bases`, {
        credentials: 'include',
      });
      if (res.ok) {
        const raw = (await res.json()) as Array<Record<string, unknown>>;
        setBases(
          raw.map(
            (row) =>
              ({
                ...row,
                enhancement_level: kbEnhancementLevel(
                  row as unknown as KnowledgeBase,
                ),
                embedding_provider_id:
                  (row.embedding_provider_id as string | null | undefined) ??
                  null,
                llm_provider_id:
                  (row.llm_provider_id as string | null | undefined) ?? null,
                llm_model_override:
                  (row.llm_model_override as string | null | undefined) ?? null,
                temporal_half_life_days:
                  typeof row.temporal_half_life_days === 'number'
                    ? row.temporal_half_life_days
                    : 365,
                allow_query_backfill:
                  row.allow_query_backfill === 1 ||
                  row.allow_query_backfill === true
                    ? 1
                    : 0,
              }) as KnowledgeBase,
          ),
        );
        setError(null);
      } else {
        setError(t('加载知识库失败: {{status}}', { status: res.status }));
      }
    } catch {
      setError(t('网络错误，无法加载知识库'));
    } finally {
      setInitialLoading(false);
    }
  }, [apiBase]);

  const showConfirm = (
    title: string,
    message: string,
    onConfirm: () => void,
  ) => {
    setConfirmState({ open: true, title, message, onConfirm });
  };

  const closeConfirm = () => {
    setConfirmState({ open: false, title: '', message: '', onConfirm: null });
  };

  const fetchDocs = useCallback(
    async (kbId: string) => {
      try {
        const res = await fetch(
          `${apiBase}/api/knowledge/bases/${kbId}/documents`,
          {
            credentials: 'include',
          },
        );
        if (res.ok) {
          setDocs(await res.json());
        } else {
          setError(t('加载文档失败: {{status}}', { status: res.status }));
        }
      } catch {
        setError(t('网络错误，无法加载文档'));
      }
    },
    [apiBase],
  );

  const fetchTreeData = useCallback(
    async (kbId: string) => {
      setTreeLoading(true);
      try {
        const res = await fetch(`${apiBase}/api/knowledge/bases/${kbId}/tree`, {
          credentials: 'include',
        });
        if (res.ok) setTreeRows((await res.json()) as KnowledgeTreeRow[]);
        else setTreeRows([]);
      } catch {
        setTreeRows([]);
      } finally {
        setTreeLoading(false);
      }
    },
    [apiBase],
  );

  const fetchProcessingStatus = useCallback(
    async (kbId: string) => {
      try {
        const res = await fetch(
          `${apiBase}/api/knowledge/bases/${kbId}/processing-status`,
          {
            credentials: 'include',
          },
        );
        if (res.ok) {
          setProcessingStatus((await res.json()) as KnowledgeProcessingStatus);
        } else {
          setProcessingStatus(null);
        }
      } catch {
        setProcessingStatus(null);
      }
    },
    [apiBase],
  );

  const fetchKnowledgeRuntimeConfig = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/config`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const data = (await res.json()) as Record<string, unknown>;
      const raw = String(data.KB_LLM_CONCURRENCY ?? '4').trim();
      setGlobalLlmConcurrency(raw || '4');
    } catch {
      /* offline */
    }
  }, [apiBase]);

  const fetchRelationsData = useCallback(
    async (kbId: string) => {
      setRelationsLoading(true);
      try {
        const res = await fetch(
          `${apiBase}/api/knowledge/bases/${kbId}/relations`,
          { credentials: 'include' },
        );
        if (res.ok) setRelations((await res.json()) as KnowledgeRelationRow[]);
        else setRelations([]);
      } catch {
        setRelations([]);
      } finally {
        setRelationsLoading(false);
      }
    },
    [apiBase],
  );

  const fetchKbGraph = useCallback(
    async (kbId: string) => {
      setGraphLoading(true);
      try {
        const params = new URLSearchParams();
        const effectiveMaxNodes = graphUseRecommendedPreset
          ? graphRecommendedSettings.maxNodes
          : graphMaxNodes;
        const effectiveMinConfidence = graphUseRecommendedPreset
          ? graphRecommendedSettings.minConfidence
          : graphMinConfidence;
        params.set('view', graphViewMode);
        params.set('max_nodes', String(effectiveMaxNodes));
        params.set('include', Array.from(graphInclude).join(','));
        params.set('min_confidence', String(effectiveMinConfidence));
        if (graphViewMode === 'focus' && graphFocusId.trim()) {
          params.set('focus_id', graphFocusId.trim());
        }
        const res = await fetch(
          `${apiBase}/api/knowledge/bases/${kbId}/graph?${params.toString()}`,
          { credentials: 'include' },
        );
        if (res.ok) {
          const data = (await res.json()) as KnowledgeGraphResponse;
          setKbGraphRaw(data);
        } else {
          setKbGraphRaw(null);
        }
      } catch {
        setKbGraphRaw(null);
      } finally {
        setGraphLoading(false);
      }
    },
    [
      apiBase,
      graphFocusId,
      graphInclude,
      graphMaxNodes,
      graphMinConfidence,
      graphRecommendedSettings,
      graphUseRecommendedPreset,
      graphViewMode,
    ],
  );

  const fetchWikiPagesData = useCallback(
    async (kbId: string) => {
      setWikiLoading(true);
      try {
        const res = await fetch(
          `${apiBase}/api/knowledge/bases/${kbId}/wiki-pages`,
          { credentials: 'include' },
        );
        if (res.ok) setWikiPages((await res.json()) as KnowledgeWikiListRow[]);
        else setWikiPages([]);
      } catch {
        setWikiPages([]);
      } finally {
        setWikiLoading(false);
      }
    },
    [apiBase],
  );

  const fetchWikiDetailRaw = useCallback(
    async (pageId: string): Promise<KnowledgeWikiDetail | null> => {
      try {
        const res = await fetch(
          `${apiBase}/api/knowledge/wiki-pages/${pageId}`,
          { credentials: 'include' },
        );
        if (res.ok) return (await res.json()) as KnowledgeWikiDetail;
      } catch {
        /* fall through */
      }
      return null;
    },
    [apiBase],
  );

  const openWikiPageDetail = useCallback(
    async (pageId: string) => {
      setWikiDetailLoading(true);
      setWikiDetail(null);
      setWikiEditing(false);
      setWikiEditError(null);
      setWikiConflictVersion(null);
      const detail = await fetchWikiDetailRaw(pageId);
      setWikiDetail(detail);
      setWikiDetailLoading(false);
    },
    [fetchWikiDetailRaw],
  );

  const openWikiSearchResult = useCallback(
    async (pageId: string) => {
      if (!selectedKbId) return;
      setUrlState({
        kb: selectedKbId,
        tab: 'content',
        content: 'wiki',
        view: null,
      });
      await fetchWikiPagesData(selectedKbId);
      await openWikiPageDetail(pageId);
    },
    [selectedKbId, setUrlState, fetchWikiPagesData, openWikiPageDetail],
  );

  const scrollWikiHeadingIntoView = useCallback((headingId: string) => {
    const el = document.getElementById(headingId);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  /** Reload wikiDetail without clearing the user's draft — used after 409 so the user
   * can rebase their work onto the latest version without losing what they typed. */
  const reloadWikiDetailKeepDraft = useCallback(async () => {
    if (!wikiDetail) return;
    const pageId = String(wikiDetail.id ?? '');
    if (!pageId) return;
    setWikiDetailLoading(true);
    const detail = await fetchWikiDetailRaw(pageId);
    if (detail) {
      setWikiDetail(detail);
      setWikiConflictVersion(null);
      setWikiEditError(
        t('已加载最新版本，您的草稿仍保留；如确认覆盖请再次保存'),
      );
    }
    setWikiDetailLoading(false);
  }, [wikiDetail, fetchWikiDetailRaw]);

  const beginWikiEdit = useCallback(() => {
    if (!wikiDetail) return;
    setWikiDraftTitle(String(wikiDetail.title ?? ''));
    setWikiDraftContent(String(wikiDetail.content ?? ''));
    setWikiEditError(null);
    setWikiConflictVersion(null);
    setWikiEditing(true);
  }, [wikiDetail]);

  const cancelWikiEdit = useCallback(() => {
    setWikiEditing(false);
    setWikiEditError(null);
    setWikiConflictVersion(null);
  }, []);

  const saveWikiEdit = useCallback(async () => {
    if (!wikiDetail || !selectedKbId) return;
    const pageId = String(wikiDetail.id ?? '');
    const expectedVersion = Number(wikiDetail.version ?? 0);
    if (!pageId || !expectedVersion) return;
    const title = wikiDraftTitle.trim();
    const content = wikiDraftContent;
    if (!title) {
      setWikiEditError(t('标题不能为空'));
      return;
    }
    if (!content.trim()) {
      setWikiEditError(t('内容不能为空'));
      return;
    }
    setWikiSaving(true);
    setWikiEditError(null);
    setWikiConflictVersion(null);
    try {
      const res = await fetch(`${apiBase}/api/knowledge/wiki-pages/${pageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title,
          content,
          expected_version: expectedVersion,
        }),
      });
      if (res.ok) {
        setWikiEditing(false);
        await openWikiPageDetail(pageId);
        await fetchWikiPagesData(selectedKbId);
      } else {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          current_version?: number;
        };
        if (res.status === 409 && typeof data.current_version === 'number') {
          setWikiConflictVersion(data.current_version);
          setWikiEditError(
            t(
              '该页已被更新到v{{version}}，您的草稿仍在编辑框；点「加载最新版」可对照新内容后再决定是否覆盖',
              { version: data.current_version },
            ),
          );
        } else {
          setWikiEditError(
            data.error || t('保存失败: {{status}}', { status: res.status }),
          );
        }
      }
    } catch {
      setWikiEditError(t('网络错误，保存失败'));
    } finally {
      setWikiSaving(false);
    }
  }, [
    apiBase,
    wikiDetail,
    wikiDraftTitle,
    wikiDraftContent,
    selectedKbId,
    openWikiPageDetail,
    fetchWikiPagesData,
  ]);

  const revertWikiEdit = useCallback(async () => {
    if (!wikiDetail || !selectedKbId) return;
    const pageId = String(wikiDetail.id ?? '');
    if (!pageId) return;
    if (
      !window.confirm(t('放弃人工修正后，下次 LLM 处理会重写本页。是否继续？'))
    )
      return;
    try {
      const res = await fetch(
        `${apiBase}/api/knowledge/wiki-pages/${pageId}/revert`,
        {
          method: 'POST',
          credentials: 'include',
        },
      );
      if (res.ok) {
        await openWikiPageDetail(pageId);
        await fetchWikiPagesData(selectedKbId);
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setWikiEditError(
          data.error || t('回滚失败: {{status}}', { status: res.status }),
        );
      }
    } catch {
      setWikiEditError(t('网络错误，回滚失败'));
    }
  }, [
    apiBase,
    wikiDetail,
    selectedKbId,
    openWikiPageDetail,
    fetchWikiPagesData,
  ]);

  useEffect(() => {
    void fetchBases();
  }, [fetchBases]);

  useEffect(() => {
    void fetchKnowledgeRuntimeConfig();
  }, [fetchKnowledgeRuntimeConfig]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/knowledge/limits`, {
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          const merged = { ...DEFAULT_LIMITS, ...data } as KbLimits;
          setLimits(merged);
          setImportDepth((d) => Math.min(d, merged.maxCrawlDepth));
          setImportMaxPages((p) => Math.min(p, merged.maxImportPages));
        }
      } catch {
        /* use defaults */
      }
    })();
  }, [apiBase]);

  useEffect(() => {
    void (async () => {
      try {
        const [embeddingRes, llmRes] = await Promise.all([
          fetch(
            `${apiBase}/api/knowledge/provider-options?capability=embedding`,
            {
              credentials: 'include',
            },
          ),
          fetch(`${apiBase}/api/knowledge/provider-options?capability=llm`, {
            credentials: 'include',
          }),
        ]);
        if (embeddingRes.ok) {
          setEmbeddingProviders((await embeddingRes.json()) as AiProvider[]);
        }
        if (llmRes.ok) {
          setLlmProviders((await llmRes.json()) as AiProvider[]);
        }
      } catch {
        setEmbeddingProviders([]);
        setLlmProviders([]);
      }
    })();
  }, [apiBase]);

  useEffect(() => {
    if (urlKb && urlKb !== selectedKbId) setSelectedKbId(urlKb);
    else if (!urlKb && selectedKbId) setSelectedKbId(null);
  }, [urlKb]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSelectedDocIds(new Set());
    setBatchMode(false);
    if (selectedKbId) {
      void fetchDocs(selectedKbId);
      void fetchProcessingStatus(selectedKbId);
    } else {
      setDocs([]);
      setProcessingStatus(null);
    }
  }, [selectedKbId, fetchDocs, fetchProcessingStatus]);

  useEffect(() => {
    if (!selectedKbId) return;
    if (drawerTab === 'tree') void fetchTreeData(selectedKbId);
    if (drawerTab === 'relations') {
      void fetchRelationsData(selectedKbId);
      void fetchKbGraph(selectedKbId);
    }
    if (drawerTab === 'wiki') void fetchWikiPagesData(selectedKbId);
  }, [
    selectedKbId,
    drawerTab,
    fetchTreeData,
    fetchRelationsData,
    fetchKbGraph,
    fetchWikiPagesData,
  ]);

  useEffect(() => {
    setGraphTypeFilter(new Set(RELATION_GRAPH_LINK_TYPES));
    setGraphViewMode('overview');
    setGraphMaxNodes(160);
    setGraphFocusId('');
    setGraphInclude(new Set(['tree', 'relations', 'wiki_source']));
    setGraphMinConfidence(0.7);
    setShowUnprocessedGraphNodes(false);
  }, [selectedKbId]);

  const isLlmRunActive = useMemo(
    () =>
      processingStatus?.stage === 'llm_processing' ||
      processingStatus?.stage === 'wiki_building',
    [processingStatus],
  );

  useEffect(() => {
    if (!selectedKbId || !isLlmRunActive) return;
    const timer = window.setInterval(() => {
      void fetchProcessingStatus(selectedKbId);
      void fetchDocs(selectedKbId);
      if (drawerTab === 'tree') void fetchTreeData(selectedKbId);
      if (drawerTab === 'wiki') void fetchWikiPagesData(selectedKbId);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [
    selectedKbId,
    isLlmRunActive,
    drawerTab,
    fetchDocs,
    fetchTreeData,
    fetchWikiPagesData,
    fetchProcessingStatus,
  ]);

  useEffect(() => {
    if (!flashDocId) return;
    const el = document.getElementById(`knowledge-doc-anchor-${flashDocId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = window.setTimeout(() => setFlashDocId(null), 2400);
    return () => window.clearTimeout(t);
  }, [flashDocId, docsPage]);

  const saveDocumentPublishedAt = async (
    docId: string,
    nextDateInput: string,
  ) => {
    const iso = dateInputToIso(nextDateInput);
    const doc = docs.find((d) => d.id === docId);
    const prevIso = doc?.published_at ?? null;
    const same =
      (iso === null && (prevIso === null || prevIso === '')) ||
      (iso !== null &&
        prevIso !== null &&
        new Date(iso).getTime() === new Date(prevIso).getTime());
    if (same) return;
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/api/knowledge/documents/${docId}/metadata`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ published_at: iso }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(
          data.error ||
            t('更新发布日期失败: {{status}}', { status: res.status }),
        );
        return;
      }
      if (selectedKbId) await fetchDocs(selectedKbId);
    } catch {
      setError(t('网络错误，更新发布日期失败'));
    }
  };

  const startLlmRun = async (
    mode: 'recover' | 'rebuild_all' | 'rebuild_docs',
    docIds?: string[],
  ) => {
    if (!selectedKb) return;
    setLlmProcessing(true);
    setError(null);
    setMaintenanceMsg(null);
    try {
      const res = await fetch(
        `${apiBase}/api/knowledge/bases/${selectedKb.id}/llm-process`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            mode,
            doc_ids: docIds ?? [],
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.status === 'already_running') {
          setMaintenanceMsg(
            t('已有重建任务在运行：剩余 {{queued}}，并发 {{concurrency}}', {
              queued: String(data.queued ?? 0),
              concurrency: String(data.concurrency ?? globalLlmConcurrency),
            }),
          );
        } else if (data.status === 'idle') {
          setMaintenanceMsg(t('没有可处理的文档'));
        } else {
          setMaintenanceMsg(
            t('{{mode}}已排队 {{queued}} 篇文档，并发 {{concurrency}}', {
              mode:
                mode === 'rebuild_all'
                  ? t('全量重建')
                  : mode === 'rebuild_docs'
                    ? t('文档重建')
                    : t('LLM 处理'),
              queued: String(data.queued ?? 0),
              concurrency: String(data.concurrency ?? globalLlmConcurrency),
            }),
          );
        }
        await fetchProcessingStatus(selectedKb.id);
        await fetchDocs(selectedKb.id);
        if (drawerTab === 'tree') await fetchTreeData(selectedKb.id);
      } else {
        setError(
          data.error || t('LLM 处理失败: {{status}}', { status: res.status }),
        );
      }
    } catch {
      setError(t('网络错误，LLM 处理失败'));
    } finally {
      setLlmProcessing(false);
    }
  };

  const handleLlmProcess = async () => {
    await startLlmRun('recover');
  };

  const handleRebuildAll = async () => {
    if (
      !window.confirm(
        t('将重新生成整个知识库的 LLM 摘要、关系和 Wiki 页面。是否继续？'),
      )
    )
      return;
    await startLlmRun('rebuild_all');
  };

  const handleRebuildDoc = async (docId: string) => {
    await startLlmRun('rebuild_docs', [docId]);
  };

  const handleSaveGlobalLlmConcurrency = async () => {
    const normalized = String(
      Math.max(1, Math.min(16, Number(globalLlmConcurrency) || 4)),
    );
    setSavingLlmConcurrency(true);
    setError(null);
    setMaintenanceMsg(null);
    try {
      const res = await fetch(`${apiBase}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ KB_LLM_CONCURRENCY: normalized }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          data.error || t('保存并发失败: {{status}}', { status: res.status }),
        );
        return;
      }
      setGlobalLlmConcurrency(normalized);
      setMaintenanceMsg(
        t('全局并发已更新为 {{concurrency}}', { concurrency: normalized }),
      );
    } catch {
      setError(t('网络错误，保存并发失败'));
    } finally {
      setSavingLlmConcurrency(false);
    }
  };

  const handleWikiLint = async () => {
    if (!selectedKb) return;
    setWikiLinting(true);
    setError(null);
    setMaintenanceMsg(null);
    try {
      const res = await fetch(
        `${apiBase}/api/knowledge/bases/${selectedKb.id}/lint`,
        {
          method: 'POST',
          credentials: 'include',
        },
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMaintenanceMsg(
          t(
            'Wiki 检查完成：孤立 {{orphan}}，过时 {{stale}}，缺失 {{missing}}，矛盾 {{contradictions}}',
            {
              orphan: Number(data.orphanPages?.length ?? 0),
              stale: Number(data.stalePages?.length ?? 0),
              missing: Number(data.missingPages?.length ?? 0),
              contradictions: Number(data.contradictions?.length ?? 0),
            },
          ),
        );
      } else {
        setError(
          data.error || t('Wiki 检查失败: {{status}}', { status: res.status }),
        );
      }
    } catch {
      setError(t('网络错误，Wiki 检查失败'));
    } finally {
      setWikiLinting(false);
    }
  };

  const handleCreateKb = async () => {
    if (!newKbName.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/knowledge/bases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: newKbName.trim(),
          description: newKbDesc.trim() || null,
          chunk_size: chunkSize,
          chunk_overlap: chunkOverlap,
          cleanup_patterns: cleanupPatterns.trim() || null,
          embedding_provider_id: newKbEmbeddingProviderId.trim() || null,
          category: newKbCategory,
          visibility: newKbVisibility,
          enhancement_level: newKbEnhancementLevel,
          llm_provider_id:
            newKbEnhancementLevel === 'metadata'
              ? null
              : newKbLlmProviderId.trim() || null,
          temporal_half_life_days: newKbTemporalHalfLifeDays,
          allow_query_backfill: newKbAllowQueryBackfill ? 1 : 0,
        }),
      });
      if (res.ok) {
        const created = await res.json();
        setNewKbName('');
        setNewKbDesc('');
        setNewKbEmbeddingProviderId('');
        setNewKbCategory('general');
        setNewKbVisibility('private');
        setNewKbEnhancementLevel('metadata');
        setNewKbLlmProviderId('');
        setNewKbTemporalHalfLifeDays(365);
        setNewKbAllowQueryBackfill(false);
        await fetchBases();
        if (created?.id) {
          setSelectedKbId(created.id);
          setUrlState({
            kb: created.id,
            tab: 'overview',
            content: null,
            view: null,
          });
        } else {
          setUrlState({ kb: null, tab: null, view: null });
        }
      } else {
        const data = await res.json().catch(() => ({}));
        setError(
          data.error || t('创建失败: {{status}}', { status: res.status }),
        );
      }
    } catch {
      setError(t('网络错误，创建知识库失败'));
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteKb = (id: string) => {
    showConfirm(
      t('删除知识库'),
      t('确定删除此知识库及其所有文档？此操作不可恢复。'),
      () => {
        void (async () => {
          closeConfirm();
          setError(null);
          try {
            const res = await fetch(`${apiBase}/api/knowledge/bases/${id}`, {
              method: 'DELETE',
              credentials: 'include',
            });
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              setError(
                data.error || t('删除失败: {{status}}', { status: res.status }),
              );
              return;
            }
            if (selectedKbId === id) {
              setSelectedKbId(null);
              setUrlState({ kb: null, tab: null, view: null });
              setSearchResults([]);
              setWikiResults([]);
            }
            if (editingKb?.id === id) {
              setEditingKb(null);
            }
            await fetchBases();
          } catch {
            setError(t('网络错误，删除知识库失败'));
          }
        })();
      },
    );
  };

  const handleToggleKb = async (kb: KnowledgeBase) => {
    setError(null);
    try {
      const res = await fetch(`${apiBase}/api/knowledge/bases/${kb.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled: kb.enabled ? 0 : 1 }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(
          data.error || t('切换失败: {{status}}', { status: res.status }),
        );
        return;
      }
      await fetchBases();
    } catch {
      setError(t('网络错误'));
    }
  };

  const handleToggleUserKb = async (kb: KnowledgeBase) => {
    setError(null);
    const enable = !kb.user_enabled;
    try {
      const res = await fetch(
        `${apiBase}/api/user/knowledge-bases/${kb.id}/${enable ? 'enable' : 'disable'}`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(
          data.error || t('切换失败: {{status}}', { status: res.status }),
        );
        return;
      }
      await fetchBases();
    } catch {
      setError(t('网络错误'));
    }
  };

  const handleUpdateKb = async () => {
    if (!editingKb) return;
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/api/knowledge/bases/${editingKb.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            name: editingKb.name,
            description: editingKb.description,
            chunk_size: editingKb.chunk_size,
            chunk_overlap: editingKb.chunk_overlap,
            cleanup_patterns: editingKb.cleanup_patterns,
            embedding_provider_id: editingKb.embedding_provider_id,
            enhancement_level: editingKb.enhancement_level,
            llm_provider_id: editingKb.llm_provider_id,
            temporal_half_life_days: editingKb.temporal_half_life_days,
            allow_query_backfill: editingKb.allow_query_backfill === 1 ? 1 : 0,
          }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(
          data.error || t('更新失败: {{status}}', { status: res.status }),
        );
        return;
      }
      setEditingKb(null);
      await fetchBases();
    } catch {
      setError(t('网络错误，更新知识库失败'));
    }
  };

  const isZipFile = (file: File) =>
    file.name.endsWith('.zip') ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed';

  const guessContentType = (name: string): string => {
    if (name.endsWith('.md') || name.endsWith('.markdown'))
      return 'text/markdown';
    if (name.endsWith('.json')) return 'application/json';
    if (name.endsWith('.csv')) return 'text/csv';
    if (name.endsWith('.html') || name.endsWith('.htm')) return 'text/html';
    if (name.endsWith('.xml')) return 'text/xml';
    if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'text/yaml';
    return 'text/plain';
  };

  const getFileExtension = (name: string): string => {
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot).toLowerCase() : '';
  };

  const isBinaryExt = (name: string): boolean =>
    BINARY_EXTENSIONS.has(getFileExtension(name));

  const uploadBinaryFile = async (
    kbId: string,
    file: File,
    relativePath?: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    if (relativePath) formData.append('relativePath', relativePath);
    const res = await fetch(
      `${apiBase}/api/knowledge/bases/${kbId}/documents/upload`,
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      },
    );
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return {
      ok: false,
      error: data.error || t('上传失败: {{status}}', { status: res.status }),
    };
  };

  const uploadSingleDoc = async (
    kbId: string,
    filename: string,
    content: string,
    relativePath?: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const res = await fetch(
      `${apiBase}/api/knowledge/bases/${kbId}/documents`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          filename,
          content,
          content_type: guessContentType(filename),
          ...(relativePath ? { relative_path: relativePath } : {}),
        }),
      },
    );
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}));
    return {
      ok: false,
      error: data.error || t('上传失败: {{status}}', { status: res.status }),
    };
  };

  const clearPendingUpload = () => {
    setUploadFileName('');
    setUploadContent('');
    setUploadProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);

    if (isZipFile(file)) {
      if (file.size > limits.maxZipSizeMb * 1024 * 1024) {
        clearPendingUpload();
        setError(
          t('压缩包过大 ({{size}}MB)，上限 {{limit}}MB', {
            size: (file.size / 1024 / 1024).toFixed(1),
            limit: limits.maxZipSizeMb,
          }),
        );
        return;
      }
      setUploadFileName(file.name);
      setUploadContent('__ZIP__');
      return;
    }

    if (file.size > limits.maxFileSizeMb * 1024 * 1024) {
      clearPendingUpload();
      setError(
        t('文件过大 ({{size}}MB)，上限 {{limit}}MB', {
          size: (file.size / 1024 / 1024).toFixed(1),
          limit: limits.maxFileSizeMb,
        }),
      );
      return;
    }

    if (isBinaryExt(file.name)) {
      setUploadFileName(file.name);
      setUploadContent('__BINARY__');
      return;
    }

    const ext = getFileExtension(file.name);
    if (!TEXT_EXTENSIONS.has(ext)) {
      clearPendingUpload();
      setError(
        t(
          '不支持的文件格式: {{ext}}，支持 .txt, .md, .csv, .json, .pdf, .docx 等',
          { ext: ext || '(无扩展名)' },
        ),
      );
      return;
    }

    setUploadFileName(file.name);
    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      setUploadContent(String(loadEvent.target?.result || ''));
    };
    reader.readAsText(file);
  };

  const handleUploadDoc = async () => {
    if (!selectedKbId || !uploadFileName) return;
    setUploading(true);
    setError(null);

    const resetInputs = clearPendingUpload;

    try {
      if (uploadContent === '__BINARY__' && fileInputRef.current?.files?.[0]) {
        const file = fileInputRef.current.files[0]!;
        const result = await uploadBinaryFile(selectedKbId, file);
        if (result.ok) {
          resetInputs();
          await fetchDocs(selectedKbId);
        } else {
          setError(result.error || t('上传失败，请检查文件格式是否正确'));
        }
      } else if (
        uploadContent === '__ZIP__' &&
        fileInputRef.current?.files?.[0]
      ) {
        const zipFile = fileInputRef.current.files[0]!;
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(zipFile);

        type ZipEntry = {
          name: string;
          file: import('jszip').JSZipObject;
          binary: boolean;
        };
        const entries: ZipEntry[] = [];

        zip.forEach((relativePath, file) => {
          if (file.dir) return;
          const ext = '.' + relativePath.split('.').pop()?.toLowerCase();
          const binary = BINARY_EXTENSIONS.has(ext);
          if (!binary && !TEXT_EXTENSIONS.has(ext)) return;
          entries.push({ name: relativePath, file, binary });
        });

        if (entries.length === 0) {
          setError(
            t(
              '压缩包中没有可识别的文件（支持 .txt, .md, .csv, .json, .pdf, .docx 等）',
            ),
          );
          return;
        }
        if (entries.length > limits.maxZipFiles) {
          setError(
            t('文件数量超过上限 ({{count}}/{{limit}})，请分批上传', {
              count: entries.length,
              limit: limits.maxZipFiles,
            }),
          );
          return;
        }

        setUploadProgress({ done: 0, total: entries.length });
        let failed = 0;

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]!;
          let ok = false;
          try {
            if (entry.binary) {
              const blob = await entry.file.async('blob');
              if (blob.size > limits.maxFileSizeMb * 1024 * 1024) {
                failed++;
                setUploadProgress({ done: i + 1, total: entries.length });
                continue;
              }
              const binaryFile = new File([blob], entry.name);
              const r = await uploadBinaryFile(
                selectedKbId,
                binaryFile,
                entry.name,
              );
              ok = r.ok;
            } else {
              const content = await entry.file.async('string');
              const byteLen = new TextEncoder().encode(content).length;
              if (byteLen > limits.maxFileSizeMb * 1024 * 1024) {
                failed++;
                setUploadProgress({ done: i + 1, total: entries.length });
                continue;
              }
              const r2 = await uploadSingleDoc(
                selectedKbId,
                entry.name,
                content,
                entry.name,
              );
              ok = r2.ok;
            }
          } catch {
            /* per-file failure is non-fatal */
          }
          if (!ok) failed++;
          setUploadProgress({ done: i + 1, total: entries.length });
        }

        resetInputs();
        if (failed > 0)
          setError(t('{{count}} 个文件上传失败', { count: failed }));
        await fetchDocs(selectedKbId);
      } else {
        if (!uploadContent) return;
        const result = await uploadSingleDoc(
          selectedKbId,
          uploadFileName,
          uploadContent,
        );
        if (result.ok) {
          resetInputs();
          await fetchDocs(selectedKbId);
        } else {
          setError(result.error || t('上传失败'));
        }
      }
    } catch (err) {
      const isZip = uploadContent === '__ZIP__';
      const msg = err instanceof Error ? err.message : '';
      setError(
        isZip && msg.includes('zip')
          ? t('压缩包格式无效或已损坏')
          : isZip
            ? t('解压或上传失败: {{error}}', { error: msg || t('未知错误') })
            : t('网络错误，上传文档失败'),
      );
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteDoc = (docId: string) => {
    showConfirm(t('删除文档'), t('确定删除此文档？此操作不可恢复。'), () => {
      void (async () => {
        closeConfirm();
        setError(null);
        try {
          const res = await fetch(
            `${apiBase}/api/knowledge/documents/${docId}`,
            {
              method: 'DELETE',
              credentials: 'include',
            },
          );
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            setError(
              data.error || t('删除失败: {{status}}', { status: res.status }),
            );
            return;
          }
          if (selectedKbId) {
            await fetchDocs(selectedKbId);
          }
        } catch {
          setError(t('网络错误，删除文档失败'));
        }
      })();
    });
  };

  const toggleDocSelection = (docId: string) => {
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) {
        next.delete(docId);
      } else {
        next.add(docId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    const currentPageDocs = docs.slice(
      (docsPage - 1) * DOCS_PAGE_SIZE,
      docsPage * DOCS_PAGE_SIZE,
    );
    const allSelected = currentPageDocs.every((d) => selectedDocIds.has(d.id));
    if (allSelected) {
      setSelectedDocIds((prev) => {
        const next = new Set(prev);
        for (const d of currentPageDocs) next.delete(d.id);
        return next;
      });
    } else {
      setSelectedDocIds((prev) => {
        const next = new Set(prev);
        for (const d of currentPageDocs) next.add(d.id);
        return next;
      });
    }
  };

  const handleBatchDelete = () => {
    if (selectedDocIds.size === 0) return;
    showConfirm(
      t('批量删除文档'),
      t('确定删除已选中的 {{count}} 个文档？此操作不可恢复。', {
        count: selectedDocIds.size,
      }),
      () => {
        void (async () => {
          closeConfirm();
          setError(null);
          const failedIds = new Set<string>();
          for (const docId of selectedDocIds) {
            try {
              const res = await fetch(
                `${apiBase}/api/knowledge/documents/${docId}`,
                {
                  method: 'DELETE',
                  credentials: 'include',
                },
              );
              if (!res.ok) failedIds.add(docId);
            } catch {
              failedIds.add(docId);
            }
          }
          if (failedIds.size > 0) {
            setError(
              t('{{count}} 个文档删除失败，已保留选中状态', {
                count: failedIds.size,
              }),
            );
            setSelectedDocIds(failedIds);
          } else {
            setSelectedDocIds(new Set());
            setBatchMode(false);
          }
          if (selectedKbId) await fetchDocs(selectedKbId);
        })();
      },
    );
  };

  const fetchChunks = async (docId: string) => {
    if (expandedDocId === docId) {
      setExpandedDocId(null);
      setDocChunks([]);
      return;
    }
    setLoadingChunks(true);
    setExpandedDocId(docId);
    setDocChunks([]);
    try {
      const res = await fetch(
        `${apiBase}/api/knowledge/documents/${docId}/chunks`,
        {
          credentials: 'include',
        },
      );
      if (res.ok) {
        setDocChunks(await res.json());
      } else {
        setDocChunks([]);
        setError(t('加载文档内容失败'));
      }
    } catch {
      setDocChunks([]);
      setError(t('网络错误，加载文档内容失败'));
    } finally {
      setLoadingChunks(false);
    }
  };

  const handleImportUrl = async () => {
    if (!selectedKbId || !importUrl.trim()) return;
    setImporting(true);
    setError(null);
    setImportResult(null);
    try {
      const res = await fetch(
        `${apiBase}/api/knowledge/bases/${selectedKbId}/import-url`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            url: importUrl.trim(),
            max_depth: importDepth,
            max_pages: importMaxPages,
            ...(importForce ? { force: true } : {}),
          }),
        },
      );
      if (res.ok) {
        const data = await res.json();
        setImportResult({
          total: data.total,
          success: data.success,
          failed: data.failed,
          skipped: data.skipped,
        });
        setImportUrl('');
        await fetchDocs(selectedKbId);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(
          data.error || t('导入失败: {{status}}', { status: res.status }),
        );
      }
    } catch {
      setError(t('网络错误，URL 导入失败'));
    } finally {
      setImporting(false);
    }
  };

  const openDocumentDetail = useCallback(
    (docId: string, options?: { expand?: boolean }) => {
      const target = docs.find((doc) => doc.id === docId);
      if (!target) return;
      const idx = docs.findIndex((doc) => doc.id === docId);
      if (idx >= 0) setDocsPage(Math.floor(idx / DOCS_PAGE_SIZE) + 1);
      setUrlState({ tab: 'content', content: 'docs', view: null });
      setFlashDocId(docId);
      if (
        options?.expand &&
        target.status === 'indexed' &&
        expandedDocId !== docId
      ) {
        void fetchChunks(docId);
      }
    },
    [docs, expandedDocId, fetchChunks, setUrlState],
  );

  const jumpToSupersedingDoc = useCallback(
    (supersedingId: string) => {
      openDocumentDetail(supersedingId);
    },
    [openDocumentDetail],
  );

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setError(null);
    setWikiResults([]);
    try {
      const payload: { query: string; top_k: number; kb_ids?: string[] } = {
        query: searchQuery.trim(),
        top_k: 10,
      };
      if (selectedKbId && !creatingKb) {
        payload.kb_ids = [selectedKbId];
      }
      const res = await fetch(`${apiBase}/api/knowledge/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setSearchResults(data);
          setWikiResults([]);
        } else {
          setSearchResults(Array.isArray(data?.chunks) ? data.chunks : []);
          const wikiRaw = (data as Record<string, unknown>)?.wiki;
          if (Array.isArray(wikiRaw)) {
            setWikiResults(
              wikiRaw
                .map((row) =>
                  row && typeof row === 'object'
                    ? parseWikiSearchRow(row as Record<string, unknown>)
                    : null,
                )
                .filter((x): x is WikiResult => x !== null),
            );
          } else {
            setWikiResults([]);
          }
        }
      } else {
        const data = await res.json().catch(() => ({}));
        setError(
          data.error || t('搜索失败: {{status}}', { status: res.status }),
        );
      }
    } catch {
      setError(t('网络错误，搜索失败'));
    } finally {
      setSearching(false);
    }
  };

  const handleSaveSearchAsWiki = async () => {
    if (!selectedKbId || (!searchResults.length && !wikiResults.length)) return;
    const titleInput = window.prompt(
      t('保存为 Wiki 页：请输入标题'),
      searchQuery.trim().slice(0, 80) || t('检索摘录'),
    );
    if (titleInput == null) return;
    const title = titleInput.trim();
    if (!title) {
      setError(t('标题不能为空'));
      return;
    }
    const content = buildSearchBackfillMarkdown(
      searchQuery.trim(),
      wikiResults,
      searchResults,
      t,
    );
    setBackfillSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiBase}/api/knowledge/bases/${selectedKbId}/wiki-pages/backfill`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            title,
            content,
            source_query: searchQuery.trim(),
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        window.alert(
          t('已保存为 Wiki 页（{{id}}…）', {
            id: String(data.page_id ?? '').slice(0, 8),
          }),
        );
        void fetchWikiPagesData(selectedKbId);
      } else {
        setError(
          data.error || t('保存失败: {{status}}', { status: res.status }),
        );
      }
    } catch {
      setError(t('网络错误，保存 Wiki 失败'));
    } finally {
      setBackfillSaving(false);
    }
  };

  const handleRebuildFts = async () => {
    setRebuildingFts(true);
    setMaintenanceMsg(null);
    try {
      const res = await fetch(`${apiBase}/api/knowledge/rebuild-fts`, {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        const parts: string[] = [
          t('分词配置: {{config}}', { config: data.ftsConfig || '—' }),
        ];
        if (data.knowledge_chunks !== undefined)
          parts.push(t('知识块: {{count}}', { count: data.knowledge_chunks }));
        if (data.memory_search_documents !== undefined)
          parts.push(
            t('搜索文档: {{count}}', { count: data.memory_search_documents }),
          );
        setMaintenanceMsg(
          t('FTS 索引重建完成 — {{parts}}', { parts: parts.join(t('，')) }),
        );
      } else {
        const data = await res.json().catch(() => ({}));
        setMaintenanceMsg(
          t('重建失败: {{error}}', { error: data.error || res.status }),
        );
      }
    } catch {
      setMaintenanceMsg(t('网络错误，重建失败'));
    } finally {
      setRebuildingFts(false);
    }
  };

  const handleBackfillEmbeddings = async () => {
    setBackfilling(true);
    setMaintenanceMsg(null);
    try {
      const res = await fetch(`${apiBase}/api/knowledge/backfill-embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        setMaintenanceMsg(
          t('向量补录完成 — 新增 {{embedded}} 条，跳过 {{skipped}} 条', {
            embedded: data.embedded,
            skipped: data.skipped,
          }),
        );
      } else {
        const data = await res.json().catch(() => ({}));
        setMaintenanceMsg(
          t('补录失败: {{error}}', { error: data.error || res.status }),
        );
      }
    } catch {
      setMaintenanceMsg(t('网络错误，补录失败'));
    } finally {
      setBackfilling(false);
    }
  };

  const handleReclean = async () => {
    if (!selectedKbId) return;
    setRecleaning(true);
    setMaintenanceMsg(null);
    try {
      const res = await fetch(
        `${apiBase}/api/knowledge/bases/${selectedKbId}/reclean`,
        {
          method: 'POST',
          credentials: 'include',
        },
      );
      if (res.ok) {
        const data = await res.json();
        const parts = [t('共 {{total}} 篇', { total: data.total ?? '?' })];
        if (data.cleaned)
          parts.push(t('清洗 {{count}} 篇', { count: data.cleaned }));
        if (data.deleted)
          parts.push(t('删除垃圾页 {{count}} 篇', { count: data.deleted }));
        if (data.unchanged)
          parts.push(t('无变化 {{count}} 篇', { count: data.unchanged }));
        if (data.failed)
          parts.push(t('失败 {{count}} 篇', { count: data.failed }));
        const hint = data.cleaned
          ? t('（向量已跳过，请点「向量补录」更新）')
          : '';
        setMaintenanceMsg(
          t('重新清洗完成 — {{parts}}{{hint}}', {
            parts: parts.join(t('，')),
            hint,
          }),
        );
        void fetchDocs(selectedKbId);
      } else {
        const data = await res.json().catch(() => ({}));
        setMaintenanceMsg(
          t('重新清洗失败: {{error}}', { error: data.error || res.status }),
        );
      }
    } catch {
      setMaintenanceMsg(t('网络错误，重新清洗失败'));
    } finally {
      setRecleaning(false);
    }
  };

  const openKbDrawer = (kbId: string) => {
    setSelectedKbId(kbId);
    setUrlState({ kb: kbId, tab: 'overview', content: null, view: null });
    setDocsPage(1);
    setSearchResults([]);
    setWikiResults([]);
  };

  const openCreateDrawer = () => {
    setSelectedKbId(null);
    setUrlState({ kb: null, tab: null, content: null, view: 'create' });
    setEditingKb(null);
  };

  const openGlobalSearch = () => {
    setSelectedKbId(null);
    setUrlState({ kb: null, tab: 'search', content: null, view: 'search' });
    setEditingKb(null);
  };

  const closeDrawer = () => {
    setUrlState({ kb: null, tab: null, content: null, view: null });
    setEditingKb(null);
    setSearchResults([]);
    setWikiResults([]);
    setGraphFullscreen(false);
  };

  const categories = useMemo(() => {
    const cats = new Set(bases.map((b) => b.category || 'general'));
    return ['all', ...Array.from(cats).sort()];
  }, [bases]);

  const filteredBases = useMemo(() => {
    let list =
      categoryFilter === 'all'
        ? bases
        : bases.filter((b) => (b.category || 'general') === categoryFilter);
    if (kbFilter.trim()) {
      const q = kbFilter.trim().toLowerCase();
      list = list.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          (b.description || '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [bases, categoryFilter, kbFilter]);

  const indexedDocCount = useMemo(
    () => docs.filter((d) => d.status === 'indexed').length,
    [docs],
  );
  const failedDocCount = useMemo(
    () => docs.filter((d) => d.status === 'failed').length,
    [docs],
  );
  const processedDocCount = processingStatus?.processed_total ?? 0;
  const processingTotal = processingStatus?.eligible_total ?? 0;
  const processingFailedCount = processingStatus?.failed ?? 0;
  const processingQueuedCount =
    processingStatus?.queued ?? processingStatus?.pending ?? 0;
  const processingStageLabel =
    processingStatus?.stage === 'wiki_building'
      ? t('构建 Wiki')
      : processingStatus?.stage === 'llm_processing'
        ? t('处理文档')
        : processingStatus?.stage === 'partial_failed'
          ? t('部分失败')
          : processingStatus?.stage === 'completed'
            ? t('已完成')
            : t('空闲');

  /* ── Workbench tab definitions ── */
  const drawerTabs = useMemo(() => {
    if (creatingKb) return [{ key: 'settings' as const, label: t('新建配置') }];
    const tabs: Array<{ key: KnowledgeWorkbenchTab; label: string }> = [
      { key: 'overview', label: t('概览') },
      { key: 'content', label: `${t('内容')}${docs.length ? ` (${docs.length})` : ''}` },
      { key: 'graph', label: t('图谱') },
      { key: 'settings', label: t('设置') },
    ];
    return tabs;
  }, [creatingKb, docs.length, t]);

  const docTitleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of docs) m.set(d.id, d.filename);
    for (const r of treeRows) m.set(r.id, r.filename);
    return m;
  }, [docs, treeRows]);

  const graphFocusOptions = useMemo(() => {
    const options = docs.map((doc) => ({
      id: doc.id,
      label: `${t('文档')} · ${doc.filename}`,
    }));
    for (const page of wikiPages) {
      options.push({
        id: page.id,
        label: `Wiki · ${wikiPageTypeLabel(page.page_type)} · ${page.title}`,
      });
    }
    return options.sort((left, right) => left.label.localeCompare(right.label));
  }, [docs, wikiPages, wikiPageTypeLabel]);

  const filteredRelations = useMemo(
    () =>
      relations.filter((r) => {
        if (!graphTypeFilter.has(r.relation_type)) return false;
        const c = Number(r.confidence);
        return Number.isFinite(c)
          ? c >= graphMinConfidence
          : graphMinConfidence <= 0;
      }),
    [relations, graphTypeFilter, graphMinConfidence],
  );

  const filteredKbGraph = useMemo(() => {
    if (!kbGraphRaw) return null;
    const visibleNodes = kbGraphRaw.nodes.filter((node) => {
      if (showUnprocessedGraphNodes) return true;
      return node.processed !== false;
    });
    const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    const links = kbGraphRaw.links.filter((l) => {
      if (!graphTypeFilter.has(l.type)) return false;
      const c = l.confidence;
      const sourceId =
        typeof l.source === 'object' && l.source !== null
          ? l.source.id
          : l.source;
      const targetId =
        typeof l.target === 'object' && l.target !== null
          ? l.target.id
          : l.target;
      if (
        !visibleNodeIds.has(String(sourceId)) ||
        !visibleNodeIds.has(String(targetId))
      )
        return false;
      if (c === undefined || c === null) return true;
      return Number(c) >= graphMinConfidence;
    });
    return { nodes: visibleNodes, links };
  }, [
    kbGraphRaw,
    graphTypeFilter,
    graphMinConfidence,
    showUnprocessedGraphNodes,
  ]);

  const toggleGraphInclude = useCallback((key: string) => {
    setGraphInclude((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (next.size === 0) next.add(key);
      return next;
    });
  }, []);

  const toggleGraphLinkType = useCallback((t: string) => {
    setGraphTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }, []);

  const focusGraphNode = useCallback(
    (node: KbGraphNode) => {
      setGraphFocusId(node.id);
      setGraphViewMode('focus');
      if (node.type === 'wiki') {
        setUrlState({ tab: 'content', content: 'wiki', view: null });
        void openWikiPageDetail(node.id);
        return;
      }
      openDocumentDetail(node.id, { expand: true });
    },
    [openDocumentDetail, openWikiPageDetail, setUrlState],
  );

  const overviewPage = useMemo(
    () => wikiPages.find((p) => p.page_type === 'overview') ?? null,
    [wikiPages],
  );

  const filteredWikiPages = useMemo(() => {
    const q = wikiSearch.trim().toLowerCase();
    return wikiPages.filter((page) => {
      if (wikiTypeFilter !== 'all' && page.page_type !== wikiTypeFilter)
        return false;
      if (!q) return true;
      return `${page.title} ${page.page_type}`.toLowerCase().includes(q);
    });
  }, [wikiPages, wikiSearch, wikiTypeFilter]);

  const wikiPagesByType = useMemo(() => {
    const map = new Map<string, KnowledgeWikiListRow[]>();
    for (const p of filteredWikiPages) {
      if (p.page_type === 'overview') continue; // overview is shown as a shortcut at the top
      const list = map.get(p.page_type) ?? [];
      list.push(p);
      map.set(p.page_type, list);
    }
    return map;
  }, [filteredWikiPages]);

  const wikiTypeOptions = useMemo(() => {
    const types = [...new Set(wikiPages.map((page) => page.page_type))].sort();
    return [
      { value: 'all', label: t('全部类型') },
      ...types.map((type) => ({ value: type, label: wikiPageTypeLabel(type) })),
    ];
  }, [wikiPages, wikiPageTypeLabel, t]);

  const refreshOverviewPage = useCallback(async () => {
    if (!selectedKbId) return;
    try {
      const res = await fetch(
        `${apiBase}/api/knowledge/bases/${selectedKbId}/overview/refresh`,
        { method: 'POST', credentials: 'include' },
      );
      if (res.ok) await fetchWikiPagesData(selectedKbId);
    } catch {
      /* refresh is best-effort; the periodic sweep will catch up */
    }
  }, [apiBase, selectedKbId, fetchWikiPagesData]);

  /* ── Render: Create / Edit form (shared by Drawer config tab + create mode) ── */
  const renderKbForm = (mode: 'create' | 'edit') => {
    const isCreate = mode === 'create';
    const name = isCreate ? newKbName : (editingKb?.name ?? '');
    const desc = isCreate ? newKbDesc : (editingKb?.description ?? '');
    const cs = isCreate ? chunkSize : (editingKb?.chunk_size ?? 300);
    const co = isCreate ? chunkOverlap : (editingKb?.chunk_overlap ?? 60);
    const cp = isCreate ? cleanupPatterns : (editingKb?.cleanup_patterns ?? '');
    const selectedEmbeddingProviderId = isCreate
      ? newKbEmbeddingProviderId
      : (editingKb?.embedding_provider_id ?? '');

    const setField = (field: string, value: string | number | null) => {
      if (isCreate) {
        if (field === 'name') setNewKbName(value as string);
        else if (field === 'description') setNewKbDesc(value as string);
        else if (field === 'chunk_size') setChunkSize(value as number);
        else if (field === 'chunk_overlap') setChunkOverlap(value as number);
        else if (field === 'cleanup_patterns')
          setCleanupPatterns(value as string);
        else if (field === 'embedding_provider_id')
          setNewKbEmbeddingProviderId(value as string);
        else if (field === 'category') setNewKbCategory(value as string);
        else if (field === 'visibility')
          setNewKbVisibility(value as 'private' | 'shared');
      } else if (editingKb) {
        setEditingKb({ ...editingKb, [field]: value });
      }
    };

    return (
      <div className="knowledge-panel-stack">
        <div className="form-group">
          <label>{t('名称')}</label>
          <input
            className="nc-input"
            value={name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder={t('例如：售后 SOP')}
          />
        </div>
        <div className="form-group">
          <label>{t('描述')}</label>
          <input
            className="nc-input"
            value={desc}
            onChange={(e) => setField('description', e.target.value || null)}
            placeholder={t('补充场景和内容范围')}
          />
        </div>
        <div className="knowledge-form-row">
          <div className="form-group">
            <label>{t('分块大小')}</label>
            <input
              className="nc-input"
              type="number"
              min={100}
              step={50}
              value={cs}
              onChange={(e) =>
                setField('chunk_size', Number(e.target.value) || 300)
              }
            />
          </div>
          <div className="form-group">
            <label>{t('重叠大小')}</label>
            <input
              className="nc-input"
              type="number"
              min={0}
              step={10}
              value={co}
              onChange={(e) =>
                setField('chunk_overlap', Number(e.target.value) || 0)
              }
            />
          </div>
        </div>
        <div className="form-group">
          <label>
            {t('自定义清理文本')}
            <span className="form-hint">{t('每行一个短语，精确匹配移除')}</span>
          </label>
          <textarea
            className="nc-input"
            rows={3}
            value={cp}
            onChange={(e) =>
              setField('cleanup_patterns', e.target.value || null)
            }
            placeholder={t('帮助文档') + '\n' + t('视频教程')}
          />
        </div>
        <div className="form-group">
          <label>{t('Embedding 配置')}</label>
          <AppSelect
            value={selectedEmbeddingProviderId}
            onChange={(value) =>
              setField('embedding_provider_id', value || null)
            }
            options={embeddingProviderOptions}
            ariaLabel={t('选择 Embedding 配置')}
            menuMatchTrigger
          />
          <p className="knowledge-note">
            {t(
              '不选择时仅使用全文检索。修改已使用的 Embedding 配置后，需要全局重新生成向量。',
            )}
          </p>
        </div>
        <div className="form-group">
          <label>{t('增强层级')}</label>
          <AppSelect
            value={
              isCreate
                ? newKbEnhancementLevel
                : (editingKb?.enhancement_level ?? 'metadata')
            }
            onChange={(value) => {
              const v = value as KnowledgeEnhancementLevel;
              if (isCreate) {
                setNewKbEnhancementLevel(v);
                if (v === 'metadata') {
                  setNewKbLlmProviderId('');
                }
              } else if (editingKb) {
                const patch: Partial<KnowledgeBase> = { enhancement_level: v };
                if (v === 'metadata') {
                  patch.llm_provider_id = null;
                }
                setEditingKb({ ...editingKb, ...patch });
              }
            }}
            options={KB_ENHANCEMENT_OPTIONS}
            ariaLabel={t('选择增强层级')}
            menuMatchTrigger
          />
        </div>
        {(isCreate
          ? newKbEnhancementLevel
          : (editingKb?.enhancement_level ?? 'metadata')) !== 'metadata' ? (
          <>
            <div className="form-group">
              <label>LLM Provider</label>
              <AppSelect
                value={
                  isCreate
                    ? newKbLlmProviderId
                    : (editingKb?.llm_provider_id ?? '')
                }
                onChange={(value) => {
                  if (isCreate) setNewKbLlmProviderId(value);
                  else if (editingKb)
                    setEditingKb({
                      ...editingKb,
                      llm_provider_id: value || null,
                    });
                }}
                options={llmProviderOptions}
                ariaLabel={t('选择 LLM Provider')}
                menuMatchTrigger
              />
            </div>
          </>
        ) : null}
        <div className="form-group">
          <label>{t('时间半衰期（天）')}</label>
          <input
            className="nc-input"
            type="number"
            min={1}
            step={1}
            value={
              isCreate
                ? newKbTemporalHalfLifeDays
                : (editingKb?.temporal_half_life_days ?? 365)
            }
            onChange={(e) => {
              const v = Math.max(1, Number(e.target.value) || 365);
              if (isCreate) setNewKbTemporalHalfLifeDays(v);
              else if (editingKb)
                setEditingKb({ ...editingKb, temporal_half_life_days: v });
            }}
          />
        </div>
        <div className="form-group knowledge-form-toggle-row">
          <NcToggle
            checked={
              isCreate
                ? newKbAllowQueryBackfill
                : editingKb?.allow_query_backfill === 1
            }
            onChange={(v) => {
              if (isCreate) setNewKbAllowQueryBackfill(v);
              else if (editingKb)
                setEditingKb({ ...editingKb, allow_query_backfill: v ? 1 : 0 });
            }}
            label={t('允许将检索结果保存为 Wiki 对比页')}
          />
        </div>
        {isCreate ? (
          <>
            <div className="knowledge-form-row">
              <div className="form-group">
                <label>{t('分类')}</label>
                <AppSelect
                  value={newKbCategory}
                  onChange={(value) => setField('category', value)}
                  options={kbCategoryOptions}
                  ariaLabel={t('选择知识库分类')}
                  menuMatchTrigger
                />
              </div>
              <div className="form-group">
                <label>{t('可见性')}</label>
                <AppSelect
                  value={newKbVisibility}
                  onChange={(value) => setField('visibility', value)}
                  options={KB_VISIBILITY_OPTIONS}
                  ariaLabel={t('选择知识库可见性')}
                  menuMatchTrigger
                />
              </div>
            </div>
            {embeddingProviders.length === 0 ? (
              <p className="knowledge-note">
                {t(
                  '当前没有可用的 Embedding Provider。知识库仍可使用 FTS 全文检索。',
                )}
              </p>
            ) : null}
          </>
        ) : null}
        <div className="modal-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              void (isCreate ? handleCreateKb() : handleUpdateKb())
            }
            disabled={isCreate ? loading || !newKbName.trim() : false}
          >
            {isCreate
              ? loading
                ? t('创建中...')
                : t('创建知识库')
              : t('保存修改')}
          </button>
          <button
            type="button"
            className="btn-outline"
            onClick={() => {
              if (isCreate) closeDrawer();
              else {
                setEditingKb(selectedKb ? { ...selectedKb } : null);
                setDetailTab('overview');
              }
            }}
          >
            {t('取消')}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="page-view knowledge-page knowledge-library-page">
      <AppHeroHeader
        title={t('知识库')}
        subtitle={t('管理知识库、文档索引和语义搜索。')}
        controls={
          <>
            <SearchPill
              value={kbFilter}
              onChange={setKbFilter}
              placeholder={t('按名称、描述筛选')}
              aria-label={t('按名称、描述筛选')}
              clearLabel={t('清空搜索')}
              leadingIcon={<IconSearch />}
            />
            <div className="knowledge-page-actions">
              <button
                type="button"
                className="btn-outline"
                onClick={openGlobalSearch}
              >
                {t('全局搜索')}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={openCreateDrawer}
              >
                {t('新建知识库')}
              </button>
            </div>
          </>
        }
      />

      <div className="page-body knowledge-page-body knowledge-library-body">
        {error ? (
          <div className="test-result error knowledge-inline-message">
            <span>{error}</span>
            <button
              type="button"
              className="knowledge-inline-close"
              onClick={() => setError(null)}
              aria-label={t('关闭错误提示')}
            >
              ×
            </button>
          </div>
        ) : null}
        {maintenanceMsg ? (
          <div className="knowledge-maintenance-msg">
            <span className="knowledge-maintenance-msg-body">
              {maintenanceMsg}
            </span>
            <button
              type="button"
              className="knowledge-inline-close"
              onClick={() => setMaintenanceMsg(null)}
              aria-label={t('关闭')}
            >
              ×
            </button>
          </div>
        ) : null}

        {initialLoading ? (
          <div className="provider-empty">{t('正在加载知识库...')}</div>
        ) : (
          <section className="knowledge-library-panel">
            <div className="knowledge-card-list-toolbar">
              <div className="knowledge-card-list-toolbar-main">
                <div className="knowledge-card-list-toolbar-copy">
                  <strong>{t('知识库列表')}</strong>
                  <span>
                    {embeddingProviders.length > 0
                      ? t('支持混合检索')
                      : t('仅 FTS 检索')}
                  </span>
                </div>
                <div className="knowledge-card-list-toolbar-actions">
                  <button
                    type="button"
                    className="btn-outline btn-xs"
                    disabled={rebuildingFts}
                    onClick={() => void handleRebuildFts()}
                    title={t('重建全文检索索引')}
                  >
                    {rebuildingFts ? t('重建中...') : t('重建 FTS')}
                  </button>
                  {embeddingProviders.length > 0 ? (
                    <button
                      type="button"
                      className="btn-outline btn-xs"
                      disabled={backfilling}
                      onClick={() => void handleBackfillEmbeddings()}
                      title={t('为缺少向量的文档补录嵌入')}
                    >
                      {backfilling ? t('补录中...') : t('向量补录')}
                    </button>
                  ) : null}
                </div>
              </div>
              {categories.length > 1 && (
                <div
                  className="knowledge-category-bar"
                  role="tablist"
                  aria-label={t('分类筛选')}
                >
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      role="tab"
                      aria-selected={categoryFilter === cat}
                      className={`knowledge-category-chip ${categoryFilter === cat ? 'active' : ''}`}
                      onClick={() => setCategoryFilter(cat)}
                    >
                      {cat === 'all'
                        ? t('全部')
                        : CATEGORY_LABELS[cat] || cat}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {filteredBases.length === 0 ? (
              <div className="provider-empty knowledge-empty-inline">
                {bases.length === 0
                  ? t('暂无知识库，点击「新建知识库」开始。')
                  : t('当前筛选条件下暂无知识库。')}
              </div>
            ) : (
              <div className="knowledge-base-grid">
                {filteredBases.map((kb) => (
                  <LibraryCard
                    key={kb.id}
                    className={`knowledge-base-card ${
                      drawerOpen && !creatingKb && selectedKbId === kb.id
                        ? 'active'
                        : ''
                    } ${kb.enabled ? '' : 'is-disabled'}`}
                    onClick={() => openKbDrawer(kb.id)}
                    heading={kb.name}
                    badge={
                      <span
                        className={`repo-review-badge ${kb.enabled ? 'enabled' : 'disabled'}`}
                      >
                        {kb.enabled ? t('已启用') : t('已停用')}
                      </span>
                    }
                    bodyClassName="knowledge-base-card-body"
                    rows={[
                      {
                        label: t('说明'),
                        value: kb.description || t('暂无描述'),
                      },
                      {
                        label: t('分类'),
                        value: `${CATEGORY_LABELS[kb.category] || kb.category || t('通用')} · ${
                          kb.visibility === 'shared' ? t('共享') : t('私有')
                        }${kb.user_enabled ? ` · ${t('已订阅')}` : ''}`,
                      },
                      {
                        label: t('检索'),
                        value: kb.embedding_provider_id
                          ? embeddingProviderLabelById.get(
                              kb.embedding_provider_id,
                            ) || t('Embedding 配置')
                          : t('仅 FTS'),
                      },
                      {
                        label: t('分块'),
                        value: `${kb.chunk_size}/${kb.chunk_overlap}`,
                      },
                      {
                        label: t('更新'),
                        value: formatTimestamp(kb.updated_at),
                      },
                    ]}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {drawerOpen ? (
        <div
          className="modal-overlay knowledge-workbench-overlay"
          onClick={closeDrawer}
        >
          <div
            className={`modal knowledge-workbench-modal${graphFullscreen ? ' is-graph-fullscreen' : ''}`}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header knowledge-workbench-header">
              <div className="knowledge-workbench-header-main">
                <h3>
                  {creatingKb
                    ? t('新建知识库')
                    : selectedKb?.name ||
                      (drawerTab === 'search'
                        ? t('全局搜索')
                        : t('知识库详情'))}
                </h3>
                {!creatingKb && selectedKb ? (
                  <p className="knowledge-workbench-subtitle">
                    {selectedKb.description || t('统一查看文档、Wiki、图谱和设置')}
                  </p>
                ) : null}
              </div>
              <div className="knowledge-workbench-header-actions">
                {!creatingKb && selectedKb ? (
                  <>
                    <span className="knowledge-status-chip">
                      {ENHANCEMENT_LEVEL_LABELS[selectedKbLevel]}
                    </span>
                    <span
                      className={`knowledge-status-chip ${selectedKb.enabled ? '' : 'is-muted'}`}
                    >
                      {selectedKb.enabled ? t('已启用') : t('已停用')}
                    </span>
                  </>
                ) : null}
                <button
                  type="button"
                  className="modal-close-btn"
                  onClick={closeDrawer}
                  aria-label={t('关闭')}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="knowledge-workbench-body">
              {!creatingKb && (selectedKb || drawerTab === 'search') && (
                <div className="knowledge-workbench-nav">
                  <TabBar
                    tabs={
                      selectedKb
                        ? drawerTabs
                        : [{ key: 'search' as const, label: t('全局搜索') }]
                    }
                    activeKey={selectedKb ? detailTab : 'search'}
                    onChange={(key) =>
                      selectedKb
                        ? setDetailTab(key as KnowledgeWorkbenchTab)
                        : openGlobalSearch()
                    }
                  />
                  {!creatingKb && selectedKb && detailTab === 'content' ? (
                    <div className="knowledge-workbench-subnav">
                      <TabBar
                        tabs={contentViewOptions.map((item) => ({
                          key: item.key,
                          label: item.label,
                        }))}
                        activeKey={contentView}
                        onChange={(key) =>
                          setContentTab(key as KnowledgeContentView)
                        }
                      />
                    </div>
                  ) : null}
                </div>
              )}

              <div className="knowledge-drawer-content">

          {/* Tab: Overview */}
          {!creatingKb && selectedKb && drawerTab === 'overview' && (
            <div className="knowledge-drawer-section">
              <div className="knowledge-overview-hero">
                <div className="knowledge-overview-copy">
                  <h3>{selectedKb.name}</h3>
                  {selectedKb.description ? (
                    <p className="settings-hint">{selectedKb.description}</p>
                  ) : null}
                </div>
                <div className="knowledge-overview-actions">
                  <div className="knowledge-overview-action-group">
                    <button
                      type="button"
                      className={`btn-sm ${selectedKb.enabled ? 'btn-warning' : 'btn-success'}`}
                      onClick={() => void handleToggleKb(selectedKb)}
                    >
                      {selectedKb.enabled ? t('停用') : t('启用')}
                    </button>
                    <button
                      type="button"
                      className={`btn-outline btn-sm ${selectedKb.user_enabled ? 'is-active' : ''}`}
                      onClick={() => void handleToggleUserKb(selectedKb)}
                    >
                      {selectedKb.user_enabled ? t('取消订阅') : t('订阅')}
                    </button>
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() => setDetailTab('settings')}
                    >
                      {t('设置')}
                    </button>
                  </div>
                  <div className="knowledge-overview-action-group knowledge-overview-action-group--utility">
                    <button
                      type="button"
                      className="btn-outline btn-xs"
                      disabled={recleaning}
                      onClick={() => void handleReclean()}
                      title={t('重新清洗并重建索引')}
                    >
                      {recleaning ? t('清洗中...') : t('重新清洗')}
                    </button>
                    {kbEnhancementLevel(selectedKb) === 'wiki_lite' ||
                    kbEnhancementLevel(selectedKb) === 'wiki_full' ? (
                      <>
                        <button
                          type="button"
                          className="btn-outline btn-xs"
                          disabled={llmProcessing || isLlmRunActive}
                          onClick={() => void handleLlmProcess()}
                          title={t('处理待处理/失败文档')}
                        >
                          {llmProcessing ? t('处理中...') : t('处理待处理')}
                        </button>
                        <button
                          type="button"
                          className="btn-outline btn-xs"
                          disabled={llmProcessing || isLlmRunActive}
                          onClick={() => void handleRebuildAll()}
                          title={t('重新生成整个知识库的摘要、关系和 Wiki')}
                        >
                          {llmProcessing ? t('处理中...') : t('全量重建')}
                        </button>
                      </>
                    ) : null}
                    {kbEnhancementLevel(selectedKb) === 'wiki_full' ? (
                      <button
                        type="button"
                        className="btn-outline btn-xs"
                        disabled={wikiLinting}
                        onClick={() => void handleWikiLint()}
                        title={t('运行 Wiki 一致性检查')}
                      >
                        {wikiLinting ? t('检查中...') : t('Wiki 检查')}
                      </button>
                    ) : null}
                    <a
                      className="btn-outline btn-xs"
                      href={`${apiBase}/api/knowledge/bases/${selectedKb.id}/events/export-md`}
                      download
                      title={t('导出 Karpathy log.md 格式事件日志')}
                    >
                      {t('导出日志')}
                    </a>
                  </div>
                </div>
              </div>
              <div className="knowledge-overview-grid">
                <div className="knowledge-overview-stat">
                  <strong>
                    {ENHANCEMENT_LEVEL_LABELS[kbEnhancementLevel(selectedKb)]}
                  </strong>
                  <span>{t('增强层级')}</span>
                </div>
                <div className="knowledge-overview-stat">
                  <strong>{selectedKb.temporal_half_life_days ?? '—'}</strong>
                  <span>{t('时间半衰期(天)')}</span>
                </div>
                <div className="knowledge-overview-stat">
                  <strong>{docs.length}</strong>
                  <span>{t('文档')}</span>
                </div>
                <div className="knowledge-overview-stat">
                  <strong>{indexedDocCount}</strong>
                  <span>{t('已索引')}</span>
                </div>
                {kbEnhancementLevel(selectedKb) === 'wiki_lite' ||
                kbEnhancementLevel(selectedKb) === 'wiki_full' ? (
                  <div className="knowledge-overview-stat">
                    <strong>
                      {processingTotal > 0
                        ? `${processedDocCount}/${processingTotal}`
                        : '—'}
                    </strong>
                    <span>{t('已处理/总计')}</span>
                  </div>
                ) : null}
                {failedDocCount > 0 && (
                  <div className="knowledge-overview-stat is-warning">
                    <strong>{failedDocCount}</strong>
                    <span>{t('失败')}</span>
                  </div>
                )}
                <div className="knowledge-overview-stat">
                  <strong>
                    {selectedKb.chunk_size}/{selectedKb.chunk_overlap}
                  </strong>
                  <span>{t('分块/重叠')}</span>
                </div>
                <div className="knowledge-overview-stat">
                  <strong>
                    {CATEGORY_LABELS[selectedKb.category] || t('通用')}
                  </strong>
                  <span>{t('分类')}</span>
                </div>
                <div className="knowledge-overview-stat">
                  <strong>
                    {selectedKb.visibility === 'shared' ? t('共享') : t('私有')}
                  </strong>
                  <span>{t('可见性')}</span>
                </div>
                <div className="knowledge-overview-stat">
                  <strong>
                    {selectedKb.allow_query_backfill === 1
                      ? t('开启')
                      : t('关闭')}
                  </strong>
                  <span>{t('查询回填 Wiki')}</span>
                </div>
                {kbEnhancementLevel(selectedKb) === 'wiki_lite' ||
                kbEnhancementLevel(selectedKb) === 'wiki_full' ? (
                  <div className="knowledge-overview-stat">
                    <strong>{globalLlmConcurrency}</strong>
                    <span>{t('全局并发')}</span>
                  </div>
                ) : null}
              </div>
              <div className="knowledge-overview-meta">
                <span>
                  {t('Embedding')}：
                  {selectedKb.embedding_provider_id
                    ? embeddingProviderLabelById.get(
                        selectedKb.embedding_provider_id,
                      ) || selectedKb.embedding_provider_id
                    : t('仅 FTS')}
                </span>
                <span>
                  LLM：
                  {selectedKb.llm_provider_id
                    ? llmProviderLabelById.get(selectedKb.llm_provider_id) ||
                      selectedKb.llm_provider_id
                    : '—'}
                </span>
                <span>
                  {t('更新于')}：{formatTimestamp(selectedKb.updated_at)}
                </span>
                <span>
                  {t('创建于')}：{formatTimestamp(selectedKb.created_at)}
                </span>
              </div>
              {kbEnhancementLevel(selectedKb) === 'wiki_lite' ||
              kbEnhancementLevel(selectedKb) === 'wiki_full' ? (
                <div className="knowledge-processing-panel">
                  <div className="knowledge-processing-head">
                    <div>
                      <strong>{processingStageLabel}</strong>
                      <div className="knowledge-processing-progress-label">
                        {processingTotal > 0
                          ? t('已处理 {{done}}/{{total}}', {
                              done: processedDocCount,
                              total: processingTotal,
                            })
                          : t('暂无运行中的处理任务')}
                        {processingStatus?.run_id
                          ? ` · Run ${processingStatus.run_id.slice(0, 8)}`
                          : ''}
                      </div>
                    </div>
                    <div>
                      <label className="knowledge-graph-spacing-inline">
                        <span>{t('并发')}</span>
                        <input
                          type="number"
                          min={1}
                          max={16}
                          value={globalLlmConcurrency}
                          onChange={(e) =>
                            setGlobalLlmConcurrency(
                              String(
                                Math.max(
                                  1,
                                  Math.min(16, Number(e.target.value) || 4),
                                ),
                              ),
                            )
                          }
                        />
                      </label>
                      <button
                        type="button"
                        className="btn-outline btn-xs"
                        onClick={() => void handleSaveGlobalLlmConcurrency()}
                        disabled={savingLlmConcurrency}
                      >
                        {savingLlmConcurrency ? t('保存中...') : t('保存并发')}
                      </button>
                    </div>
                  </div>
                  <div className="knowledge-processing-bar">
                    <div
                      className="knowledge-processing-bar-fill"
                      style={{
                        width: `${Math.max(0, Math.min(100, processingStatus?.progress_percent ?? 0))}%`,
                      }}
                    />
                  </div>
                  <div className="knowledge-processing-stats">
                    <span>
                      {t('排队')} {processingQueuedCount}
                    </span>
                    <span>
                      {t('处理中')} {processingStatus?.processing ?? 0}
                    </span>
                    <span>Wiki {processingStatus?.wiki_processing ?? 0}</span>
                    <span>
                      {t('失败')} {processingFailedCount}
                    </span>
                    <span>
                      {t('本轮并发')}{' '}
                      {processingStatus?.concurrency_used ??
                        globalLlmConcurrency}
                    </span>
                  </div>
                  {processingStatus?.active_docs?.length ? (
                    <div className="knowledge-processing-active-list">
                      {processingStatus.active_docs.map((entry) => (
                        <div
                          key={entry.id}
                          className="knowledge-processing-active-item"
                        >
                          <strong>{entry.filename}</strong>
                          <span>
                            {entry.llm_status === 'wiki'
                              ? t('构建 Wiki')
                              : t('处理中')}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="knowledge-overview-actions-bottom">
                <button
                  type="button"
                  className="btn-danger btn-sm"
                  onClick={() => handleDeleteKb(selectedKb.id)}
                >
                  {t('删除知识库')}
                </button>
              </div>
            </div>
          )}

          {/* Tab: Documents */}
          {!creatingKb && selectedKb && drawerTab === 'docs' && (
            <div className="knowledge-drawer-section">
              <div className="knowledge-upload-toolbar">
                <input
                  ref={fileInputRef}
                  className="knowledge-file-input"
                  type="file"
                  accept=".txt,.md,.markdown,.csv,.json,.log,.yml,.yaml,.xml,.html,.htm,.pdf,.docx,.zip"
                  onChange={handleFileSelect}
                />
                <button
                  type="button"
                  className="knowledge-file-select-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <span className="knowledge-file-select-label">
                    {uploadFileName || t('选择文件')}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void handleUploadDoc()}
                  disabled={uploading || !uploadFileName}
                >
                  {uploading
                    ? uploadProgress
                      ? `${uploadProgress.done}/${uploadProgress.total}`
                      : t('处理中...')
                    : t('上传并索引')}
                </button>
              </div>
              {uploadFileName &&
              (uploadFileName.endsWith('.zip') ||
                isBinaryExt(uploadFileName)) ? (
                <p className="knowledge-note">
                  {uploadFileName.endsWith('.zip')
                    ? t('压缩包，将自动解压文本和文档文件')
                    : t('二进制文档，将在服务端提取文本')}
                </p>
              ) : null}
              {uploadProgress ? (
                <div className="knowledge-upload-progress">
                  <div
                    className="knowledge-upload-progress-bar"
                    style={{
                      width: `${(uploadProgress.done / uploadProgress.total) * 100}%`,
                    }}
                  />
                </div>
              ) : null}

              <div className="knowledge-url-import-section">
                <div className="knowledge-url-import-row">
                  <input
                    className="nc-input knowledge-url-input"
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                    placeholder={t('网页链接导入，如 https://docs.example.com')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleImportUrl();
                    }}
                  />
                  <NcSelect
                    className="knowledge-url-depth"
                    value={importDepth}
                    onChange={(e) => setImportDepth(Number(e.target.value))}
                  >
                    <option value={0}>{t('仅此页')}</option>
                    {Array.from({ length: limits.maxCrawlDepth }, (_, i) => (
                      <option key={i + 1} value={i + 1}>
                        {t('子链接 {{depth}} 层', { depth: i + 1 })}
                      </option>
                    ))}
                  </NcSelect>
                  <input
                    type="number"
                    className="nc-input nc-input-sm knowledge-url-max-pages"
                    value={importMaxPages}
                    onChange={(e) =>
                      setImportMaxPages(
                        Math.max(
                          1,
                          Math.min(
                            limits.maxImportPages,
                            Number(e.target.value) || 50,
                          ),
                        ),
                      )
                    }
                    min={1}
                    max={limits.maxImportPages}
                    title={t('最大页数')}
                    placeholder={t('页数')}
                  />
                  <NcCheckbox
                    className="knowledge-url-force-inline"
                    checked={importForce}
                    onChange={(e) => setImportForce(e.target.checked)}
                    label={t('强制')}
                  />
                  <button
                    type="button"
                    className="btn-outline btn-sm"
                    onClick={() => void handleImportUrl()}
                    disabled={importing || !importUrl.trim()}
                  >
                    {importing ? t('导入中...') : t('网页导入')}
                  </button>
                </div>
                {importResult ? (
                  <p className="knowledge-note">
                    {t(
                      '导入完成：共 {{total}} 页，成功 {{success}}，失败 {{failed}}',
                      {
                        total: importResult.total,
                        success: importResult.success,
                        failed: importResult.failed,
                      },
                    )}
                    {importResult.skipped
                      ? t('，跳过 {{skipped}}', {
                          skipped: importResult.skipped,
                        })
                      : ''}
                  </p>
                ) : null}
                {importing ? (
                  <p className="knowledge-note">
                    {t('正在抓取网页，深层链接可能需要较长时间...')}
                  </p>
                ) : null}
              </div>

              {docs.length === 0 ? (
                <div className="provider-empty knowledge-empty-inline">
                  {t('暂无文档，上传文件或导入网页后这里会显示索引状态。')}
                </div>
              ) : (
                <div className="knowledge-document-list">
                  <div className="knowledge-batch-toolbar">
                    <NcToggle
                      className="knowledge-batch-toggle"
                      checked={batchMode}
                      onChange={(v) => {
                        setBatchMode(v);
                        if (!v) setSelectedDocIds(new Set());
                      }}
                      label={t('批量操作')}
                    />
                    {batchMode ? (
                      <>
                        <button
                          type="button"
                          className="btn-outline btn-xs"
                          onClick={toggleSelectAll}
                        >
                          {t('全选/取消')}
                        </button>
                        <button
                          type="button"
                          className="btn-danger btn-xs"
                          onClick={handleBatchDelete}
                          disabled={selectedDocIds.size === 0}
                        >
                          {t('删除选中')} ({selectedDocIds.size})
                        </button>
                      </>
                    ) : null}
                  </div>
                  <Pagination
                    page={docsPage}
                    pageSize={DOCS_PAGE_SIZE}
                    total={docs.length}
                    onPageChange={setDocsPage}
                  />
                  {docs
                    .slice(
                      (docsPage - 1) * DOCS_PAGE_SIZE,
                      docsPage * DOCS_PAGE_SIZE,
                    )
                    .map((doc) => (
                      <div
                        key={doc.id}
                        id={`knowledge-doc-anchor-${doc.id}`}
                        className={`knowledge-document-item-wrapper${flashDocId === doc.id ? ' knowledge-doc-flash' : ''}`}
                      >
                        <div className="knowledge-document-row">
                          {batchMode ? (
                            <NcCheckbox
                              className="knowledge-batch-checkbox"
                              checked={selectedDocIds.has(doc.id)}
                              onChange={() => toggleDocSelection(doc.id)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : null}
                          <div className="knowledge-document-main">
                            <div className="knowledge-document-title-row">
                              <strong
                                className={`knowledge-document-title ${doc.superseded_by ? 'knowledge-superseded' : ''}`}
                              >
                                {doc.filename}
                              </strong>
                              {doc.superseded_by ? (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  className="knowledge-llm-badge failed knowledge-supersede-link"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    jumpToSupersedingDoc(doc.superseded_by!);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      jumpToSupersedingDoc(doc.superseded_by!);
                                    }
                                  }}
                                  title={t('已被文档 {{id}} 替代', {
                                    id: doc.superseded_by,
                                  })}
                                >
                                  {t('已替代')} →
                                </span>
                              ) : null}
                              {kbEnhancementLevel(selectedKb) === 'wiki_lite' ||
                              kbEnhancementLevel(selectedKb) === 'wiki_full'
                                ? renderKnowledgeLlmBadge(doc.llm_status)
                                : null}
                            </div>
                            {docPathBreadcrumb(doc.doc_path) ? (
                              <div
                                className="knowledge-doc-path"
                                title={doc.doc_path || ''}
                              >
                                {docPathBreadcrumb(doc.doc_path)}
                              </div>
                            ) : null}
                            <div className="knowledge-document-status-row">
                              <span
                                className={`knowledge-document-status ${getDocumentStatusClass(doc.status)}`}
                              >
                                {STATUS_LABELS[doc.status] || doc.status}
                              </span>
                              <label className="knowledge-published-field">
                                <span className="knowledge-published-label">
                                  {t('发布日')}
                                </span>
                                <input
                                  type="date"
                                  className="nc-input nc-input-sm knowledge-date-input"
                                  defaultValue={publishedDateInputValue(
                                    doc.published_at,
                                  )}
                                  key={`${doc.id}-${doc.published_at ?? ''}`}
                                  onBlur={(e) =>
                                    void saveDocumentPublishedAt(
                                      doc.id,
                                      e.target.value,
                                    )
                                  }
                                />
                              </label>
                            </div>
                            <div className="knowledge-document-meta">
                              <span>
                                {doc.chunk_count} {t('块')}
                              </span>
                              <span>
                                {doc.char_count} {t('字符')}
                              </span>
                              <span>
                                {t('更新于')} {formatTimestamp(doc.updated_at)}
                              </span>
                            </div>
                            {doc.source_url &&
                            /^https?:\/\//i.test(doc.source_url) ? (
                              <div className="knowledge-document-source-url">
                                {t('来源')}：
                                <a
                                  href={doc.source_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {doc.source_url}
                                </a>
                              </div>
                            ) : doc.source_url ? (
                              <div className="knowledge-document-source-url">
                                {t('来源')}：{doc.source_url}
                              </div>
                            ) : null}
                            {doc.error_message ? (
                              <div className="knowledge-document-error">
                                {doc.error_message}
                              </div>
                            ) : null}
                          </div>
                          <div className="knowledge-document-actions">
                            <button
                              type="button"
                              className="btn-outline btn-sm"
                              onClick={() => void fetchChunks(doc.id)}
                              disabled={doc.status !== 'indexed'}
                            >
                              {expandedDocId === doc.id
                                ? t('收起')
                                : t('查看内容')}
                            </button>
                            {kbEnhancementLevel(selectedKb) === 'wiki_lite' ||
                            kbEnhancementLevel(selectedKb) === 'wiki_full' ? (
                              <button
                                type="button"
                                className="btn-outline btn-sm"
                                onClick={() => void handleRebuildDoc(doc.id)}
                                disabled={
                                  doc.status !== 'indexed' ||
                                  llmProcessing ||
                                  isLlmRunActive
                                }
                              >
                                {t('重建')}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn-danger btn-sm"
                              onClick={() => handleDeleteDoc(doc.id)}
                            >
                              {t('删除')}
                            </button>
                          </div>
                        </div>
                        {expandedDocId === doc.id ? (
                          <div className="knowledge-chunks-panel">
                            {loadingChunks ? (
                              <p className="knowledge-note">{t('加载中...')}</p>
                            ) : docChunks.length === 0 ? (
                              <p className="knowledge-note">
                                {t('无分块内容')}
                              </p>
                            ) : (
                              docChunks.map((chunk) => (
                                <div
                                  key={chunk.id}
                                  className="knowledge-chunk-item"
                                >
                                  <div className="knowledge-chunk-header">
                                    <span className="knowledge-chunk-index">
                                      {t('块')} #{chunk.chunk_index + 1}
                                    </span>
                                    <span className="knowledge-chunk-tokens">
                                      {chunk.token_count} tokens
                                    </span>
                                  </div>
                                  <pre className="knowledge-chunk-content">
                                    {chunk.content}
                                  </pre>
                                </div>
                              ))
                            )}
                          </div>
                        ) : null}
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}

          {!creatingKb && selectedKb && drawerTab === 'tree' && (
            <div className="knowledge-drawer-section">
              {(kbEnhancementLevel(selectedKb) === 'wiki_lite' ||
                kbEnhancementLevel(selectedKb) === 'wiki_full') &&
              processingStatus ? (
                <div className="knowledge-processing-panel">
                  <div className="knowledge-processing-head">
                    <div>
                      <strong>{processingStageLabel}</strong>
                      <div className="knowledge-processing-progress-label">
                        {t('已处理 {{done}}/{{total}}', {
                          done: processedDocCount,
                          total: processingTotal || 0,
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="knowledge-processing-bar">
                    <div
                      className="knowledge-processing-bar-fill"
                      style={{
                        width: `${Math.max(0, Math.min(100, processingStatus.progress_percent || 0))}%`,
                      }}
                    />
                  </div>
                  <div className="knowledge-processing-stats">
                    <span>
                      {t('排队')} {processingQueuedCount}
                    </span>
                    <span>
                      {t('处理中')} {processingStatus.processing}
                    </span>
                    <span>Wiki {processingStatus.wiki_processing}</span>
                    <span>
                      {t('失败')} {processingFailedCount}
                    </span>
                  </div>
                </div>
              ) : null}
              {treeLoading ? (
                <p className="knowledge-note">{t('加载中...')}</p>
              ) : null}
              {!treeLoading && treeRows.length === 0 ? (
                <div className="provider-empty knowledge-empty-inline">
                  {t('暂无树数据')}
                </div>
              ) : (
                <div className="knowledge-tree-list">
                  {treeRows.map((row) => (
                    <div
                      key={row.id}
                      className={`knowledge-tree-item ${row.superseded_by ? 'knowledge-superseded' : ''}`}
                      style={{
                        paddingLeft: `${12 + Math.min(row.depth, 8) * 16}px`,
                      }}
                    >
                      <div className="knowledge-tree-item-main">
                        <span className="knowledge-tree-name">
                          {row.filename}
                        </span>
                        {row.superseded_by ? (
                          <span className="knowledge-status-chip is-muted knowledge-superseded-tag">
                            {t('已替代')}
                          </span>
                        ) : null}
                        <span
                          className={`knowledge-document-status ${getDocumentStatusClass(row.status)}`}
                        >
                          {STATUS_LABELS[row.status] || row.status}
                        </span>
                        {kbEnhancementLevel(selectedKb) === 'wiki_lite' ||
                        kbEnhancementLevel(selectedKb) === 'wiki_full'
                          ? renderKnowledgeLlmBadge(row.llm_status)
                          : null}
                      </div>
                      <div className="knowledge-tree-item-meta">
                        {row.published_at ? (
                          <span>{formatTimestamp(row.published_at)}</span>
                        ) : (
                          <span className="knowledge-tree-muted">
                            {t('未设发布日')}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!creatingKb && selectedKb && drawerTab === 'relations' && (
            <div className="knowledge-drawer-section knowledge-relations-panel">
              <div className="knowledge-graph-workbench-head">
                <div
                  className="knowledge-graph-toggle"
                  role="group"
                  aria-label={t('关联展示方式')}
                >
                  <button
                    type="button"
                    className={
                      relationsPresentation === 'graph' ? 'is-active' : ''
                    }
                    onClick={() => setRelationsPresentation('graph')}
                  >
                    {t('力图')}
                  </button>
                  <button
                    type="button"
                    className={
                      relationsPresentation === 'table' ? 'is-active' : ''
                    }
                    onClick={() => setRelationsPresentation('table')}
                  >
                    {t('表格')}
                  </button>
                </div>
                {relationsPresentation === 'graph' ? (
                  <div className="knowledge-graph-head-actions">
                    <button
                      type="button"
                      className="btn-outline btn-sm"
                      onClick={() => setGraphFullscreen(true)}
                    >
                      {t('全屏图谱')}
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="knowledge-graph-filters">
                <div className="knowledge-graph-filter-row">
                  <NcCheckbox
                    className="knowledge-graph-filter-cb"
                    checked={graphUseRecommendedPreset}
                    onChange={(e) =>
                      setGraphUseRecommendedPreset(e.target.checked)
                    }
                    label={t('graph.recommended')}
                  />
                  <label className="knowledge-graph-select-label">
                    <span>{t('视图')}</span>
                    <NcSelect
                      value={graphViewMode}
                      onChange={(e) =>
                        setGraphViewMode(
                          e.target.value as KnowledgeGraphViewMode,
                        )
                      }
                    >
                      <option value="overview">{t('概览')}</option>
                      <option value="focus">{t('聚焦')}</option>
                      <option value="full">{t('全量')}</option>
                    </NcSelect>
                  </label>
                  <label className="knowledge-graph-select-label">
                    <span>{t('节点上限')}</span>
                    <NcSelect
                      value={
                        graphUseRecommendedPreset
                          ? graphRecommendedSettings.maxNodes
                          : graphMaxNodes
                      }
                      onChange={(e) => setGraphMaxNodes(Number(e.target.value))}
                      disabled={graphUseRecommendedPreset}
                    >
                      {[80, 120, 160, 240, 360, 500, 800].map((count) => (
                        <option key={count} value={count}>
                          {count}
                        </option>
                      ))}
                    </NcSelect>
                  </label>
                  <label className="knowledge-graph-select-label knowledge-graph-focus-select">
                    <span>{t('聚焦节点')}</span>
                    <NcSelect
                      value={graphFocusId}
                      onChange={(e) => {
                        setGraphFocusId(e.target.value);
                        if (e.target.value) setGraphViewMode('focus');
                      }}
                    >
                      <option value="">{t('未选择')}</option>
                      {graphFocusOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </NcSelect>
                  </label>
                </div>
                {graphUseRecommendedPreset ? (
                  <p className="knowledge-note">
                    {t('graph.recommendedHint', {
                      maxNodes: graphRecommendedSettings.maxNodes,
                      confidence: Math.round(
                        graphRecommendedSettings.minConfidence * 100,
                      ),
                    })}
                  </p>
                ) : null}
                <span className="knowledge-graph-filters-label">
                  {t('图层')}
                </span>
                <div className="knowledge-graph-filters-types">
                  {[
                    ['tree', t('文档树')],
                    ['relations', t('语义关系')],
                    ['wiki_source', t('Wiki 来源')],
                  ].map(([key, label]) => (
                    <NcCheckbox
                      key={key}
                      className="knowledge-graph-filter-cb"
                      checked={graphInclude.has(key)}
                      onChange={() => toggleGraphInclude(key)}
                      label={label}
                    />
                  ))}
                </div>
                <span className="knowledge-graph-filters-label">
                  {t('关系类型')}
                </span>
                <div className="knowledge-graph-filters-types">
                  {RELATION_GRAPH_LINK_TYPES.map((relType) => (
                    <NcCheckbox
                      key={relType}
                      className="knowledge-graph-filter-cb"
                      checked={graphTypeFilter.has(relType)}
                      onChange={() => toggleGraphLinkType(relType)}
                      label={getRelationTypeLabel(relType, t)}
                    />
                  ))}
                </div>
                <label className="knowledge-graph-confidence">
                  <span>
                    {t('最低置信度')}{' '}
                    {(
                      (graphUseRecommendedPreset
                        ? graphRecommendedSettings.minConfidence
                        : graphMinConfidence) * 100
                    ).toFixed(0)}
                    %
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(
                      (graphUseRecommendedPreset
                        ? graphRecommendedSettings.minConfidence
                        : graphMinConfidence) * 100,
                    )}
                    disabled={graphUseRecommendedPreset}
                    onChange={(e) =>
                      setGraphMinConfidence(Number(e.target.value) / 100)
                    }
                  />
                </label>
                <NcCheckbox
                  className="knowledge-graph-filter-cb"
                  checked={showUnprocessedGraphNodes}
                  onChange={(e) =>
                    setShowUnprocessedGraphNodes(e.target.checked)
                  }
                  label={t('显示未处理节点')}
                />
              </div>
              {relationsPresentation === 'graph' ? (
                <>
                  {graphLoading ? (
                    <p className="knowledge-note">{t('加载关联图...')}</p>
                  ) : null}
                  {!graphLoading &&
                  (!kbGraphRaw || kbGraphRaw.nodes.length === 0) ? (
                    <div className="provider-empty knowledge-empty-inline">
                      {t('暂无文档或 Wiki 数据')}
                    </div>
                  ) : null}
                  {!graphLoading &&
                  kbGraphRaw &&
                  kbGraphRaw.nodes.length > 0 &&
                  graphTypeFilter.size === 0 ? (
                    <p className="knowledge-note">
                      {t('请至少选择一种关系类型')}
                    </p>
                  ) : null}
                  {!graphLoading &&
                  kbGraphRaw &&
                  kbGraphRaw.nodes.length > 0 &&
                  filteredKbGraph &&
                  filteredKbGraph.nodes.length === 0 ? (
                    <p className="knowledge-note">
                      {t(
                        '当前没有已处理节点；可勾选“显示未处理节点”查看全量结构。',
                      )}
                    </p>
                  ) : null}
                  {!graphLoading &&
                  kbGraphRaw &&
                  kbGraphRaw.nodes.length > 0 &&
                  graphTypeFilter.size > 0 &&
                  filteredKbGraph ? (
                    <Suspense
                      fallback={
                        <p className="knowledge-note">{t('加载关联图组件…')}</p>
                      }
                    >
                      <KnowledgeGraph
                        graphData={filteredKbGraph}
                        stats={kbGraphRaw.stats ?? null}
                        hiddenCounts={kbGraphRaw.hidden_counts ?? null}
                        height={680}
                        onNodeClick={focusGraphNode}
                        viewScope={`${selectedKbId ?? 'global'}:${graphViewMode}:${graphFocusId || 'none'}`}
                      />
                    </Suspense>
                  ) : null}
                </>
              ) : (
                <>
                  {relationsLoading ? (
                    <p className="knowledge-note">{t('加载中...')}</p>
                  ) : null}
                  {!relationsLoading && relations.length === 0 ? (
                    <div className="provider-empty knowledge-empty-inline">
                      {t('暂无关联记录')}
                    </div>
                  ) : null}
                  {!relationsLoading &&
                  relations.length > 0 &&
                  filteredRelations.length === 0 ? (
                    <div className="provider-empty knowledge-empty-inline">
                      {t('无符合筛选条件的关联')}
                    </div>
                  ) : null}
                  {!relationsLoading && filteredRelations.length > 0 ? (
                    <div className="knowledge-relations-table-wrap">
                      <table className="knowledge-relations-table">
                        <thead>
                          <tr>
                            <th>{t('来源文档')}</th>
                            <th>{t('关系')}</th>
                            <th>{t('目标文档')}</th>
                            <th>{t('置信度')}</th>
                            <th>{t('说明')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredRelations.map((rel) => (
                            <tr key={rel.id}>
                              <td>
                                {docTitleById.get(rel.source_doc_id) ||
                                  rel.source_doc_id}
                              </td>
                              <td>
                                <span
                                  className={`knowledge-relation-badge is-${rel.relation_type}`}
                                >
                                  {relationTypeCn(rel.relation_type)}
                                </span>
                              </td>
                              <td>
                                {docTitleById.get(rel.target_doc_id) ||
                                  rel.target_doc_id}
                              </td>
                              <td>
                                {Number.isFinite(Number(rel.confidence))
                                  ? Number(rel.confidence).toFixed(2)
                                  : String(rel.confidence ?? '')}
                              </td>
                              <td className="knowledge-relations-detail">
                                {rel.detail || '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          )}

          {!creatingKb && selectedKb && drawerTab === 'wiki' && (
            <div className="knowledge-drawer-section knowledge-wiki-tab">
              <div className="knowledge-overview-shortcut">
                {overviewPage ? (
                  <button
                    type="button"
                    className="knowledge-overview-open btn-outline"
                    onClick={() => void openWikiPageDetail(overviewPage.id)}
                    title={t('打开自动维护的知识库总目录')}
                  >
                    <strong>{t('知识库索引')}</strong>
                    <span className="knowledge-wiki-card-meta">
                      v{overviewPage.version}
                    </span>
                  </button>
                ) : (
                  <span className="knowledge-note">
                    {t(
                      '尚未生成知识库索引（5 分钟内自动构建，或点右侧立即生成）',
                    )}
                  </span>
                )}
                <button
                  type="button"
                  className="btn-outline btn-xs"
                  onClick={() => void refreshOverviewPage()}
                >
                  {overviewPage ? t('刷新索引') : t('立即生成')}
                </button>
              </div>
              {wikiLoading ? (
                <p className="knowledge-note">{t('加载中...')}</p>
              ) : null}
              {!wikiLoading && wikiPages.length === 0 ? (
                <div className="provider-empty knowledge-empty-inline">
                  {t('暂无 Wiki 页面')}
                </div>
              ) : (
                <div className="knowledge-wiki-browser">
                  <aside className="knowledge-wiki-sidebar">
                    <div className="knowledge-wiki-toolbar">
                      <div className="knowledge-search-shell">
                        <span className="knowledge-search-icon">
                          <IconSearch />
                        </span>
                        <input
                          className="knowledge-search-filter-input"
                          value={wikiSearch}
                          onChange={(e) => setWikiSearch(e.target.value)}
                          placeholder={t('搜索 Wiki 页面')}
                        />
                        {wikiSearch ? (
                          <button
                            type="button"
                            className="knowledge-search-clear"
                            onClick={() => setWikiSearch('')}
                            aria-label={t('清除 Wiki 搜索')}
                          >
                            <IconX />
                          </button>
                        ) : null}
                      </div>
                      <NcSelect
                        value={wikiTypeFilter}
                        onChange={(e) => setWikiTypeFilter(e.target.value)}
                      >
                        {wikiTypeOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </NcSelect>
                    </div>
                    <div className="knowledge-wiki-grid-wrap">
                      {Array.from(wikiPagesByType.entries()).map(
                        ([pageType, pages]) => (
                          <div
                            key={pageType}
                            className="knowledge-wiki-type-block"
                          >
                            <h4 className="knowledge-wiki-type-title">
                              {wikiPageTypeLabel(pageType)}
                            </h4>
                            <div className="knowledge-wiki-cards">
                              {pages.map((p) => {
                                const edited =
                                  Number(p.edited_by_human ?? 0) === 1;
                                const selected =
                                  String(wikiDetail?.id ?? '') === p.id;
                                return (
                                  <button
                                    key={p.id}
                                    type="button"
                                    className={`knowledge-wiki-card btn-outline${edited ? ' is-edited' : ''}${selected ? ' is-selected' : ''}`}
                                    onClick={() =>
                                      void openWikiPageDetail(p.id)
                                    }
                                    title={
                                      edited
                                        ? t('此页已被人工修正，LLM 不再覆盖')
                                        : undefined
                                    }
                                  >
                                    <strong>{p.title}</strong>
                                    <span className="knowledge-wiki-card-meta">
                                      v{p.version}
                                      {edited ? (
                                        <span
                                          className="knowledge-wiki-edited-dot"
                                          aria-label={t('已修正')}
                                        />
                                      ) : null}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ),
                      )}
                      {filteredWikiPages.length === 0 ? (
                        <div className="provider-empty knowledge-empty-inline">
                          {t('无匹配 Wiki 页面')}
                        </div>
                      ) : null}
                    </div>
                  </aside>
                  <section className="knowledge-wiki-main">
                    {wikiDetailLoading ? (
                      <p className="knowledge-note">{t('加载页面...')}</p>
                    ) : null}
                    {wikiDetail && !wikiDetailLoading ? (
                      (() => {
                        const isEdited =
                          Number(wikiDetail.edited_by_human ?? 0) === 1;
                        const editedAt =
                          wikiDetail.edited_at == null
                            ? null
                            : String(wikiDetail.edited_at);
                        const pageType = String(wikiDetail.page_type ?? '');
                        const editable = pageType !== 'overview';
                        const draftBytes = new Blob([wikiDraftContent]).size;
                        const draftKB = (draftBytes / 1024).toFixed(1);
                        const overLimit = draftBytes > 512 * 1024;
                        const content = String(wikiDetail.content ?? '');
                        const headings = extractMarkdownHeadings(content);
                        const claims = wikiDetail.claims ?? [];
                        const sourceDocIds = parseWikiSourceDocIds(
                          wikiDetail.source_doc_ids,
                        );
                        return (
                          <div className="knowledge-wiki-detail-panel">
                            <div className="knowledge-wiki-detail-head">
                              <strong>
                                {wikiEditing ? t('编辑中：') : ''}
                                {String(wikiDetail.title ?? '')}
                              </strong>
                              <span className="knowledge-status-chip">
                                {wikiPageTypeLabel(pageType)}
                              </span>
                              <span className="knowledge-wiki-card-meta">
                                v{Number(wikiDetail.version ?? 1)}
                              </span>
                              {isEdited && !wikiEditing ? (
                                <span
                                  className="knowledge-wiki-edited-badge"
                                  title={
                                    editedAt
                                      ? t('人工修正于 {{date}}；LLM 不再覆盖', {
                                          date: formatTimestamp(editedAt),
                                        })
                                      : t('此页已被人工修正，LLM 不再覆盖')
                                  }
                                >
                                  {t('已修正')}
                                </span>
                              ) : null}
                              <span className="knowledge-wiki-detail-spacer" />
                              {editable && !wikiEditing ? (
                                <button
                                  type="button"
                                  className="btn-outline btn-xs"
                                  onClick={beginWikiEdit}
                                >
                                  {t('编辑')}
                                </button>
                              ) : null}
                              {editable && isEdited && !wikiEditing ? (
                                <button
                                  type="button"
                                  className="btn-outline btn-xs"
                                  onClick={() => void revertWikiEdit()}
                                  title={t(
                                    '清除人工修正标记，下次 LLM 处理会重写',
                                  )}
                                >
                                  {t('回滚 LLM 覆盖')}
                                </button>
                              ) : null}
                              {!wikiEditing ? (
                                <button
                                  type="button"
                                  className="btn-outline btn-xs"
                                  onClick={() => setWikiDetail(null)}
                                >
                                  {t('关闭')}
                                </button>
                              ) : null}
                            </div>
                            {!wikiEditing ? (
                              <>
                                <div className="knowledge-wiki-state-row">
                                  <span>
                                    {t('更新于')}{' '}
                                    {formatTimestamp(
                                      String(wikiDetail.updated_at ?? ''),
                                    )}
                                  </span>
                                  <span>
                                    {t('来源 {{count}} 篇', {
                                      count: sourceDocIds.length,
                                    })}
                                  </span>
                                  <span>
                                    {t('事实 {{count}} 条', {
                                      count: claims.length,
                                    })}
                                  </span>
                                  {isEdited ? (
                                    <span>{t('人工锁定')}</span>
                                  ) : (
                                    <span>{t('LLM 可维护')}</span>
                                  )}
                                </div>
                                {sourceDocIds.length > 0 ? (
                                  <div className="knowledge-wiki-source-list">
                                    {sourceDocIds.map((docId) => (
                                      <button
                                        key={docId}
                                        type="button"
                                        className="knowledge-wiki-source-chip"
                                        onClick={() =>
                                          openDocumentDetail(docId, {
                                            expand: true,
                                          })
                                        }
                                      >
                                        {docTitleById.get(docId) || docId}
                                      </button>
                                    ))}
                                  </div>
                                ) : null}
                              </>
                            ) : null}
                            {wikiEditing ? (
                              <div className="knowledge-wiki-edit-area">
                                <input
                                  className="nc-input"
                                  value={wikiDraftTitle}
                                  onChange={(e) =>
                                    setWikiDraftTitle(e.target.value)
                                  }
                                  placeholder={t('Wiki 页标题')}
                                  maxLength={255}
                                />
                                <textarea
                                  className="nc-input"
                                  rows={20}
                                  value={wikiDraftContent}
                                  onChange={(e) =>
                                    setWikiDraftContent(e.target.value)
                                  }
                                  placeholder={t('Markdown 内容（最大 512KB）')}
                                />
                                <small
                                  className={`knowledge-note${overLimit ? ' knowledge-wiki-edit-error' : ''}`}
                                >
                                  {t(
                                    '草稿 {{size}} KB / 512 KB · 当前对应 v{{version}}',
                                    {
                                      size: draftKB,
                                      version: Number(wikiDetail.version ?? 1),
                                    },
                                  )}
                                </small>
                                {wikiEditError ? (
                                  <p className="knowledge-note knowledge-wiki-edit-error">
                                    {wikiEditError}
                                  </p>
                                ) : null}
                                <div className="knowledge-wiki-edit-actions">
                                  <button
                                    type="button"
                                    className="btn-primary"
                                    onClick={() => void saveWikiEdit()}
                                    disabled={wikiSaving || overLimit}
                                  >
                                    {wikiSaving ? t('保存中…') : t('保存')}
                                  </button>
                                  {wikiConflictVersion !== null ? (
                                    <button
                                      type="button"
                                      className="btn-outline btn-sm"
                                      onClick={() =>
                                        void reloadWikiDetailKeepDraft()
                                      }
                                      disabled={wikiSaving}
                                      title={t(
                                        '拉取最新版本以对照，但保留您当前的草稿',
                                      )}
                                    >
                                      {t('加载最新版（保留草稿）')}
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="btn-outline btn-sm"
                                    onClick={cancelWikiEdit}
                                    disabled={wikiSaving}
                                  >
                                    {t('取消')}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                {headings.length > 0 ? (
                                  <div className="knowledge-wiki-toc">
                                    <span className="knowledge-wiki-type-title">
                                      {t('目录')}
                                    </span>
                                    {headings.map((heading) => (
                                      <button
                                        key={heading.id}
                                        type="button"
                                        className={`knowledge-wiki-toc-link${heading.level === 3 ? ' is-nested' : ''}`}
                                        onClick={() =>
                                          scrollWikiHeadingIntoView(heading.id)
                                        }
                                      >
                                        {heading.text}
                                      </button>
                                    ))}
                                  </div>
                                ) : null}
                                {claims.length > 0 ? (
                                  <div className="knowledge-wiki-claims">
                                    <span className="knowledge-wiki-type-title">
                                      {t('核心事实')}
                                    </span>
                                    {claims.map((claim) => (
                                      <details
                                        key={claim.id}
                                        className="knowledge-wiki-claim"
                                      >
                                        <summary>
                                          <span>{claim.claim_text}</span>
                                          <em>
                                            {Math.round(
                                              Number(claim.confidence ?? 0) *
                                                100,
                                            )}
                                            %
                                          </em>
                                        </summary>
                                        {claim.evidence ? (
                                          <div className="knowledge-wiki-evidence">
                                            <button
                                              type="button"
                                              className="knowledge-wiki-evidence-link"
                                              onClick={() =>
                                                openDocumentDetail(
                                                  claim.evidence!.documentId,
                                                  { expand: true },
                                                )
                                              }
                                            >
                                              {claim.evidence.filename ||
                                                claim.evidence.documentId}{' '}
                                              · chunk #
                                              {claim.evidence.chunkIndex + 1}
                                            </button>
                                            <p>{claim.evidence.content}</p>
                                          </div>
                                        ) : (
                                          <p className="knowledge-note">
                                            {t(
                                              '暂无绑定证据，保留为低置信事实。',
                                            )}
                                          </p>
                                        )}
                                      </details>
                                    ))}
                                  </div>
                                ) : null}
                                <div className="knowledge-wiki-content markdown-body">
                                  <Suspense
                                    fallback={
                                      <p className="knowledge-note">
                                        {t('加载 Wiki 正文…')}
                                      </p>
                                    }
                                  >
                                    <MarkdownContent
                                      content={content}
                                      headingIdPrefix="knowledge-wiki"
                                    />
                                  </Suspense>
                                </div>
                              </>
                            )}
                            {!wikiEditing && wikiEditError ? (
                              <p className="knowledge-note knowledge-wiki-edit-error">
                                {wikiEditError}
                              </p>
                            ) : null}
                          </div>
                        );
                      })()
                    ) : !wikiDetailLoading ? (
                      <div className="provider-empty knowledge-empty-inline">
                        {t('选择左侧 Wiki 页面查看详情')}
                      </div>
                    ) : null}
                  </section>
                </div>
              )}
            </div>
          )}

          {/* Tab: Search (works with or without selectedKb for global search) */}
          {!creatingKb && drawerTab === 'search' && (
            <div className="knowledge-drawer-section">
              {embeddingProviders.length === 0 ? (
                <p className="knowledge-note">
                  {t(
                    '当前没有可用的 Embedding Provider，检索将使用 FTS 全文匹配。',
                  )}
                </p>
              ) : null}
              <div className="knowledge-search-toolbar">
                <div className="form-group" style={{ flex: '1 1 0' }}>
                  <input
                    className="nc-input"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleSearch();
                    }}
                    placeholder={t('输入问题检索知识片段')}
                  />
                </div>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void handleSearch()}
                  disabled={searching || !searchQuery.trim()}
                >
                  {searching ? t('搜索中...') : t('搜索')}
                </button>
                {!creatingKb &&
                selectedKbId &&
                (searchResults.length > 0 || wikiResults.length > 0) ? (
                  <button
                    type="button"
                    className="btn-outline btn-sm knowledge-search-backfill-btn"
                    disabled={backfillSaving}
                    onClick={() => void handleSaveSearchAsWiki()}
                  >
                    {backfillSaving ? t('保存中…') : t('保存为 Wiki')}
                  </button>
                ) : null}
              </div>
              {searchResults.length === 0 &&
              wikiResults.length === 0 &&
              !searching ? (
                <div className="provider-empty knowledge-empty-inline">
                  {t('输入查询后展示命中的知识片段和相似度。')}
                </div>
              ) : null}
              {wikiResults.length > 0 || searchResults.length > 0 ? (
                <div className="knowledge-search-results-wrap">
                  {wikiResults.length > 0 ? (
                    <div className="knowledge-wiki-results-section">
                      <h4>{t('Wiki 匹配')}</h4>
                      {wikiResults.map((wr) => (
                        <article
                          key={wr.pageId}
                          className="knowledge-wiki-result-card"
                        >
                          <div className="knowledge-wiki-result-header">
                            <strong>{wr.title}</strong>
                            <span
                              className={`knowledge-relation-badge ${wr.pageType}`}
                            >
                              {wikiPageTypeLabel(wr.pageType)}
                            </span>
                            {wr.isStale ? (
                              <span className="knowledge-llm-badge failed">
                                {t('过时')}
                              </span>
                            ) : null}
                            <span className="knowledge-result-score">
                              {t('相似度')} {(wr.score * 100).toFixed(1)}%
                            </span>
                          </div>
                          <p className="knowledge-search-result-copy">
                            {t('来源 {{count}} 篇', {
                              count: wr.sourceDocIds.length,
                            })}{' '}
                            · {t('更新于')}{' '}
                            {wr.updatedAt
                              ? formatTimestamp(wr.updatedAt)
                              : t('未知时间')}
                          </p>
                          {wr.sourceDocIds.length > 0 ? (
                            <div className="knowledge-wiki-source-list">
                              {wr.sourceDocIds.map((docId) => (
                                <button
                                  key={`${wr.pageId}-${docId}`}
                                  type="button"
                                  className="knowledge-wiki-source-chip"
                                  onClick={() =>
                                    openDocumentDetail(docId, { expand: true })
                                  }
                                >
                                  {docTitleById.get(docId) || docId}
                                </button>
                              ))}
                            </div>
                          ) : null}
                          <p className="knowledge-search-result-copy">
                            {wr.content.length > 300
                              ? `${wr.content.slice(0, 300)}...`
                              : wr.content}
                          </p>
                          {wr.claimEvidence && wr.claimEvidence.length > 0 ? (
                            <details className="knowledge-doc-summary-fold">
                              <summary>
                                {t('核心事实')} ({wr.claimEvidence.length})
                              </summary>
                              <div className="knowledge-wiki-claims knowledge-wiki-result-claims">
                                {wr.claimEvidence.map((claim) => (
                                  <div
                                    key={claim.claimId}
                                    className="knowledge-wiki-claim"
                                  >
                                    <div className="knowledge-wiki-claim-summary">
                                      <span>{claim.claimText}</span>
                                      <em>
                                        {Math.round(claim.confidence * 100)}%
                                      </em>
                                    </div>
                                    {claim.content ? (
                                      <p className="knowledge-search-result-copy">
                                        {claim.filename
                                          ? `${claim.filename}: `
                                          : ''}
                                        {claim.content}
                                      </p>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            </details>
                          ) : null}
                          <div className="knowledge-document-actions">
                            <button
                              type="button"
                              className="btn-outline btn-sm"
                              onClick={() =>
                                void openWikiSearchResult(wr.pageId)
                              }
                            >
                              {t('打开 Wiki 页')}
                            </button>
                          </div>
                          {wr.evidenceChunks.length > 0 ? (
                            <details className="knowledge-doc-summary-fold">
                              <summary>
                                {t('查看证据')} ({wr.evidenceChunks.length})
                              </summary>
                              <div className="knowledge-search-results">
                                {wr.evidenceChunks.map((evidence, index) => (
                                  <article
                                    key={`${wr.pageId}-${evidence.chunkId || index}`}
                                    className="knowledge-search-result"
                                  >
                                    <div className="knowledge-search-result-meta">
                                      <div>
                                        <button
                                          type="button"
                                          className="knowledge-search-result-link"
                                          onClick={() =>
                                            openDocumentDetail(
                                              evidence.documentId,
                                              { expand: true },
                                            )
                                          }
                                        >
                                          {t('证据')} #{index + 1}
                                          {evidence.filename
                                            ? ` · ${evidence.filename}`
                                            : ''}
                                          {evidence.kbName
                                            ? ` · ${evidence.kbName}`
                                            : ''}
                                        </button>
                                        <p className="knowledge-search-result-copy">
                                          {t('块序号')}{' '}
                                          {evidence.chunkIndex + 1}
                                        </p>
                                      </div>
                                      <span className="knowledge-result-score">
                                        {t('匹配')}{' '}
                                        {(evidence.score * 100).toFixed(1)}%
                                      </span>
                                    </div>
                                    <p className="knowledge-search-result-copy">
                                      {evidence.content.length > 500
                                        ? `${evidence.content.slice(0, 500)}...`
                                        : evidence.content}
                                    </p>
                                  </article>
                                ))}
                              </div>
                            </details>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  ) : null}
                  {searchResults.length > 0 ? (
                    <div className="knowledge-search-results">
                      {searchResults.map((result, index) => (
                        <article
                          key={result.chunkId}
                          className="knowledge-search-result"
                        >
                          <div className="knowledge-search-result-meta">
                            <div>
                              <strong className="knowledge-search-result-title">
                                #{index + 1}
                                {result.filename ? ` · ${result.filename}` : ''}
                                {result.kbName ? ` · ${result.kbName}` : ''}
                              </strong>
                              <p className="knowledge-search-result-copy">
                                {t('块序号')} {result.chunkIndex}
                                {result.docPath ? (
                                  <span className="knowledge-doc-breadcrumb">
                                    {result.docPath.replace(/\//g, ' › ')}
                                  </span>
                                ) : null}
                                {result.publishedAt ? (
                                  <span className="knowledge-doc-date">
                                    {result.publishedAt.slice(0, 10)}
                                  </span>
                                ) : null}
                                {result.enhancementLevel ? (
                                  <span className="knowledge-search-enhancement">
                                    {result.enhancementLevel}
                                  </span>
                                ) : null}
                              </p>
                              {result.docSummary ? (
                                <details className="knowledge-doc-summary-fold">
                                  <summary>{t('文档摘要')}</summary>
                                  <p>{result.docSummary}</p>
                                </details>
                              ) : null}
                            </div>
                            <span className="knowledge-result-score">
                              {t('相似度')} {(result.score * 100).toFixed(1)}%
                            </span>
                          </div>
                          <p className="knowledge-search-result-copy">
                            {result.content.length > 500
                              ? `${result.content.slice(0, 500)}...`
                              : result.content}
                          </p>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          {/* Tab: Config (edit mode) */}
          {!creatingKb && selectedKb && drawerTab === 'config' && (
            <div className="knowledge-drawer-section">
              {editingKb ? (
                renderKbForm('edit')
              ) : (
                <p className="knowledge-note">{t('正在准备配置表单...')}</p>
              )}
            </div>
          )}

          {creatingKb && (
            <div className="knowledge-drawer-section">
              {renderKbForm('create')}
            </div>
          )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {graphFullscreen && filteredKbGraph ? (
        <div
          className="modal-overlay knowledge-graph-fullscreen-overlay"
          onClick={() => setGraphFullscreen(false)}
        >
          <div
            className="modal knowledge-graph-fullscreen-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('全屏图谱')}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>{t('知识图谱')}</h3>
              <div className="knowledge-graph-head-actions">
                <button
                  type="button"
                  className="btn-outline btn-sm"
                  onClick={() => setGraphViewMode('overview')}
                >
                  {t('重置为概览')}
                </button>
                <button
                  type="button"
                  className="modal-close-btn"
                  onClick={() => setGraphFullscreen(false)}
                  aria-label={t('关闭')}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="knowledge-graph-fullscreen-body">
              <Suspense
                fallback={<p className="knowledge-note">{t('加载关联图组件…')}</p>}
              >
                <KnowledgeGraph
                  graphData={filteredKbGraph}
                  stats={kbGraphRaw?.stats ?? null}
                  hiddenCounts={kbGraphRaw?.hidden_counts ?? null}
                  height={Math.max(window.innerHeight - 180, 560)}
                  onNodeClick={focusGraphNode}
                  viewScope={`${selectedKbId ?? 'global'}:${graphViewMode}:${graphFocusId || 'none'}:fullscreen`}
                />
              </Suspense>
            </div>
          </div>
        </div>
      ) : null}

      {/* Confirm modal */}
      {confirmState.open ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={confirmState.title}
          onClick={closeConfirm}
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeConfirm();
          }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <div
            className="modal modal-confirm"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{confirmState.title}</h3>
            <p className="confirm-message">{confirmState.message}</p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-outline"
                onClick={closeConfirm}
              >
                {t('取消')}
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => confirmState.onConfirm?.()}
              >
                {t('确定')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
