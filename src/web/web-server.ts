import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { WebSocketServer } from 'ws';

import fs from 'fs';
import { setDetectedBaseUrl } from '../detected-base-url.js';
import type { AccessPolicy } from '../auth/access-policy.js';
import { runWithTenant, SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { getUserByUsername, isMultiUserMode } from '../user/user-service.js';
import {
  resolveConversationAccessState,
  resolveLegacyAccessPolicy,
} from '../auth/access-policy.js';
import {
  createLocalCapabilityMiddleware,
  getLocalCapabilityHttpStatus,
  resolveLocalCapability,
  resolveLocalCapabilitiesForUsername,
} from '../auth/local-capability-policy.js';
import { DATA_DIR } from '../config.js';
import {
  getConfiguredChannelInstances,
  getConfigValue,
  WEB_CONFIG_KEYS,
} from '../config-store.js';
import {
  bindConversationIdentity,
  createPersonProfile,
  getConfigCachedSync,
  getConversationListByAssistantId,
  getPersonProfile,
  getRegisteredGroup,
  listConversationIdentityBindingsForPerson,
  listIdentityAliases,
  listPersonProfiles,
} from '../db.js';
import { logger } from '../logger.js';
import { startNonOverlappingBackgroundLoop } from '../runtime/background-loop.js';
import {
  createMemoryIdentityService,
  type MemoryIdentityAlias,
  type MemoryIdentityProfile,
  type MemoryIdentityRepository,
} from '../memory/identity-service.js';
import { getConversationLastEventSeq } from '../runtime/realtime-events.js';
import { recordAuditLog } from '../db/audit-log.js';
import { createConversationAdminSupport } from '../conversation/conversation-admin-support.js';
import {
  readPendingAsksForConversation as readPendingAsks,
  writeAskResponseForConversation as writeAskResponse,
} from '../conversation/conversation-ask-support.js';
import { createConversationSummaryDecorator } from '../conversation/conversation-summary.js';
import { selectDirectoryNative } from './directory-picker.js';
import { createHttpRequestLoggingMiddleware } from './request-logging.js';
import {
  applyProcessConfigSideEffects,
  createAuditMutation,
  getSanitizedWebConfig,
  hasTrustedOrigin,
  isUnsafeMethod,
  parseBoundedInteger,
  summarizeConfigEffects,
} from './web-server-support.js';
import { serializeAuthCookie } from '../auth/web-auth.js';
import { createWebAuthRuntime } from '../auth/web-auth-runtime.js';
import { clearCodexConversationState } from '../agent/codex-compat.js';
import {
  isFeatureEnabled,
  isTrustedRequestOrigin,
} from '../auth/web-security.js';
import { createRateLimitMiddleware } from '../auth/rate-limit.js';
import { AgentUploadedFile, type StructuredOutboundMessage } from '../types.js';
import { registerAuthRoutes } from '../routes/auth-routes.js';
import {
  registerPublicShareRoutes,
  registerShareRoutes,
} from '../routes/share-routes.js';
import { registerAdminSettingsRoutes } from '../routes/admin-settings-routes.js';
import { registerAssistantRoutes } from '../routes/assistant-routes.js';
import { registerAssistantRepoRoutes } from '../routes/assistant-repo-routes.js';
import {
  registerConversationAdminRoutes,
  type CreateConversationFeishuDocInput,
  type CreateConversationFeishuDocResult,
} from '../routes/conversation-admin-routes.js';
import { registerConversationMemoryRoutes } from '../routes/conversation-memory-routes.js';
import { registerConversationMessageRoutes } from '../routes/conversation-message-routes.js';
import { registerMemoryIdentityRoutes } from '../routes/memory-identity-routes.js';
import { registerTaskSessionRoutes } from '../routes/task-session-routes.js';
import { registerSystemReadRoutes } from '../routes/system-read-routes.js';
import { registerInternalMemoryRoutes } from '../routes/internal-memory-routes.js';
import { registerInternalReviewRoutes } from '../routes/internal-review-routes.js';
import { registerInternalKnowledgeRoutes } from '../routes/internal-knowledge-routes.js';
import { registerRuntimeCustomizationRoutes } from '../routes/runtime-customization-routes.js';
import { registerBrowserRoutes } from '../routes/browser-routes.js';
import { getBrowserService } from '../browser/service.js';
import { registerStockAnalysisRoutes } from '../routes/stock-analysis-routes.js';
import {
  registerRepoReviewAdminRoutes,
  registerRepoReviewIngressRoutes,
} from '../routes/repo-review-routes.js';
import { registerRepositoryRoutes } from '../routes/repository-routes.js';
import { registerResourceBindingRoutes } from '../routes/resource-binding-routes.js';
import { registerCodeSearchRoutes } from '../routes/code-search-routes.js';
import { registerCodeIndexRoutes } from '../routes/code-index-routes.js';
import { registerCodeMapRoutes } from '../routes/code-map-routes.js';
import { registerImFriendRoutes } from '../routes/im-friend-routes.js';
import { registerImFileRoutes } from '../routes/im-file-routes.js';
import { registerImGroupRoutes } from '../routes/im-group-routes.js';
import { registerImRoutes } from '../routes/im-routes.js';
import { LocalFileStorage } from '../im/im-file-storage.js';
import { startImFileCleanup } from '../im/im-file-cleanup.js';
import { registerUserRoutes } from '../routes/user-routes.js';
import { registerSoulRoutes } from '../routes/soul-routes.js';
import { registerTavernRoutes } from '../routes/tavern-routes.js';
import { registerPromptRoutes } from '../routes/prompt-routes.js';
import { registerKnowledgeRoutes } from '../routes/knowledge-routes.js';
import { createPermissionMiddleware } from '../auth/auth-middleware.js';
import { localeMiddleware } from '../i18n/middleware.js';
import { registerAvailableProviderRoutes } from '../routes/available-provider-routes.js';
import { registerUserProviderRoutes } from '../routes/user-provider-routes.js';
import { registerChannelInstanceRoutes } from '../routes/channel-instance-routes.js';
import {
  captureWhatsAppWebhookRawBody,
  registerWhatsAppWebhookRoutes,
} from '../routes/whatsapp-webhook-routes.js';
import { registerLive2DRoutes } from '../routes/live2d-routes.js';
import { registerUserMcpRoutes } from '../routes/user-mcp-routes.js';
import { registerUserSkillRoutes } from '../routes/user-skill-routes.js';
import { registerWorkteamSupportRoutes } from '../routes/workteam-routes.js';
import { recoverActiveRuns } from '../workteam/orchestrator.js';
import { registerWorkflowRoutes } from '../routes/workflow-routes.js';
import { recoverActiveWorkflowRuns } from '../workflow/orchestrator.js';
import { registerResourceAccessRoutes } from '../routes/resource-access-routes.js';
import { registerPublicLibraryRoutes } from '../routes/public-library-routes.js';
import { registerAdminMarketplaceRoutes } from '../routes/admin-marketplace-routes.js';
import { registerAdminTrashRoutes } from '../routes/admin-trash-routes.js';
import { registerAdminAuditRoutes } from '../routes/admin-audit-routes.js';
import { registerRegistryRoutes } from '../routes/registry-routes.js';
import {
  normalizeCodexApiBase,
  readFirstCodexChatCompletionText,
} from '../provider/provider-api.js';
import {
  getExtensionInstallsForResponse as getExtensionInstallsForResponseService,
  getExtensionMarketplaceCatalog as getExtensionMarketplaceCatalogService,
  getExtensionMarketplaceSourcesForResponse as getExtensionMarketplaceSourcesForResponseService,
  importExtensionFromInput as importExtensionFromInputService,
  installMarketplaceExtensionFromInput as installMarketplaceExtensionFromInputService,
  persistExtensionMarketplaceSources as persistExtensionMarketplaceSourcesService,
  reconcileExtensionInstalls as reconcileExtensionInstallsService,
  uninstallExtensionFromInput as uninstallExtensionFromInputService,
} from '../extension/extension-marketplace-service.js';
import {
  createSkillWithAiFromInput as createManagedSkillWithAiFromInput,
  getManagedSkillDetailForResponse as getManagedSkillDetailForResponseService,
  getManagedMcpServersForResponse as getManagedMcpServersForResponseService,
  getManagedSkillsForResponse as getManagedSkillsForResponseService,
  installCustomSkillFromPath as installCustomSkillFromPathService,
  installManagedMcpServerFromInput as installManagedMcpServerFromInputService,
  persistManagedMcpServers as persistManagedMcpServersService,
} from '../runtime/runtime-customization-service.js';
import { createSlashCommandExecutor } from '../slash-commands/slash-commands.js';
import {
  deriveTaskTitle,
  generateAiTaskDraft,
} from '../scheduler/task-draft.js';
import { createUploadedFileSupport } from './uploaded-files.js';
import {
  attachRealtimeWebSocketHandler,
  attachTerminalWebSocketHandler,
} from './websocket-handlers.js';
import {
  isAuthorizedInternalApiRequest,
  isAuthorizedInternalBrowserApiRequest,
} from '../auth/internal-api-auth.js';

const SENSITIVE_CONFIG_KEYS = new Set([
  'WEB_LOGIN_PASSWORD',
  'WEB_SEARCH_TAVILY_API_KEY',
]);
const CHAT_UPLOADS_ROOT = path.join(DATA_DIR, 'uploads');
const IM_UPLOADS_ROOT = path.join(DATA_DIR, 'im-uploads');
const IM_FILE_TTL_DAYS = parseInt(process.env.IM_FILE_TTL_DAYS || '7', 10);
const IM_FILE_TTL_MS = IM_FILE_TTL_DAYS * 24 * 60 * 60 * 1000;
const DEFAULT_JSON_BODY_LIMIT = '4mb';
const MAX_UPLOAD_FILES_PER_REQUEST = 5;
const MAX_UPLOAD_BYTES_PER_FILE = 5 * 1024 * 1024;
const MAX_UPLOAD_TEXT_EXCERPT_BYTES = 12 * 1024;
const MAX_UPLOAD_TEXT_EXCERPT_CHARS = 4000;
const UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const ORPHAN_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MESSAGE_PAGE_SIZE = 50;
const MAX_MESSAGE_PAGE_SIZE = 200;

const webAuthRuntime = createWebAuthRuntime({
  getConfigEntry: (key) => getConfigCachedSync(key),
});

const {
  loginThrottle,
  getLoginCredentials,
  clearBootstrapCredentials,
  getAuthenticatedUsername,
  isLoginEnabled,
  isRegistrationEnabled,
  isStockAnalysisEnabled,
  isWebTerminalEnabled,
  getRequestClientKey,
  isAuthenticatedRequest,
} = webAuthRuntime;

// authSessions is accessed via getter so it tracks session store replacement
function getAuthSessions() {
  return webAuthRuntime.authSessions;
}

export { webAuthRuntime };

export interface WebServerOptions {
  port: number;
  getChannelStatus: () => { name: string; connected: boolean }[];
  getAgentStatus: () => { activeAgents: number; queuedTasks: number };
  refreshTaskSnapshots?: () => void;
  runTaskNow?: (
    taskId: string,
  ) =>
    | { ok: boolean; error?: string }
    | Promise<{ ok: boolean; error?: string }>;
  getTaskRuntimeState?: (taskId: string) => 'queued' | 'running' | null;
  handleWebInput?: (
    jid: string,
    content: string,
    senderName?: string,
    extras?: { uploadedFiles?: AgentUploadedFile[]; clientId?: string },
  ) =>
    | {
        messageId: string;
        serverTimestamp: string;
        runId: string;
        clientId?: string;
        lastEventSeq?: number;
      }
    | Promise<{
        messageId: string;
        serverTimestamp: string;
        runId: string;
        clientId?: string;
        lastEventSeq?: number;
      }>;
  sendStructuredMessage?: (
    jid: string,
    message: StructuredOutboundMessage,
  ) => Promise<void>;
  createWebConversation?: (
    jid: string,
    name: string,
    options?: {
      assistantId?: string;
      tavernPersonaId?: string;
      accessPolicy?: AccessPolicy;
      mode?: string;
      channel?: string;
      ownerUserId?: string;
    },
  ) =>
    | { folder: string; accessPolicy: AccessPolicy }
    | null
    | Promise<{ folder: string; accessPolicy: AccessPolicy } | null>;
  createChannelConversation?: (input: {
    type: string;
    instanceId?: string;
    name: string;
    assistantId?: string;
    target?: Record<string, unknown>;
  }) =>
    | {
        jid: string;
        name: string;
        accessPolicy?: AccessPolicy;
      }
    | null
    | Promise<{
        jid: string;
        name: string;
        accessPolicy?: AccessPolicy;
      } | null>;
  updateConversationAccessPolicy?: (
    jid: string,
    accessPolicy: AccessPolicy,
  ) => { folder: string } | null | Promise<{ folder: string } | null>;
  setConversationProviderOverride?: (
    jid: string,
    providerId: string | null,
    model: string | null,
  ) => boolean | Promise<boolean>;
  resetConversationRuntime?: (jid: string, groupFolder?: string) => void;
  interruptConversationReply?: (jid: string) => boolean;
  regenerateConversationReply?: (
    jid: string,
    turnId?: string,
  ) => void | Promise<void>;
  createConversationFeishuDoc?: (
    input: CreateConversationFeishuDocInput,
  ) =>
    | CreateConversationFeishuDocResult
    | Promise<CreateConversationFeishuDocResult>;
  reloadChannels?: () => Promise<{
    disconnected: string[];
    connected: string[];
    errors: string[];
  }>;
}

type ApprovalDecision = 'allow-once' | 'deny';

export interface PublicHealthStatus {
  status: 'ok';
  service: 'nanoclaw';
  timestamp: string;
  uptime: number;
}

export function buildPublicHealthStatus(now = new Date()): PublicHealthStatus {
  return {
    status: 'ok',
    service: 'nanoclaw',
    timestamp: now.toISOString(),
    uptime: process.uptime(),
  };
}

export function registerPublicHealthRoutes(app: express.Express): void {
  const handleHealth: express.RequestHandler = (_req, res) => {
    res.json(buildPublicHealthStatus());
  };

  app.get('/healthz', handleHealth);
  app.get('/readyz', handleHealth);

  let clientErrorBudget = 20;
  setInterval(() => {
    clientErrorBudget = Math.min(clientErrorBudget + 5, 20);
  }, 60_000);

  app.post('/api/client-error', express.json({ limit: '16kb' }), (req, res) => {
    if (clientErrorBudget <= 0) {
      res.status(429).end();
      return;
    }
    const body = req.body as
      | {
          message?: string;
          stack?: string;
          componentStack?: string;
          url?: string;
          timestamp?: string;
        }
      | undefined;
    if (body?.message) {
      clientErrorBudget--;
      logger.error(
        {
          clientError: body.message.slice(0, 500),
          stack: body.stack?.slice(0, 2000),
          componentStack: body.componentStack?.slice(0, 1000),
          clientUrl: body.url?.slice(0, 500),
        },
        'Frontend error reported',
      );
    }
    res.status(204).end();
  });
}

export function createApiProtectionMiddleware(deps: {
  hasTrustedOrigin: (req: express.Request) => boolean;
  isUnsafeMethod: (method: string) => boolean;
  isAuthorizedInternalBrowserApiRequest: (req: express.Request) => boolean;
  isAuthenticatedRequest: (req: express.Request) => boolean;
  logger: {
    warn: (obj: object, msg: string) => void;
  };
}): {
  requireTrustedOrigin: express.RequestHandler;
  requireAuth: express.RequestHandler;
} {
  const requireTrustedOrigin: express.RequestHandler = (req, res, next) => {
    if (
      !deps.isUnsafeMethod(req.method) ||
      deps.hasTrustedOrigin(req) ||
      deps.isAuthorizedInternalBrowserApiRequest(req)
    ) {
      next();
      return;
    }
    deps.logger.warn(
      {
        method: req.method,
        origin: req.headers.origin,
        host: req.headers.host,
      },
      'Blocked API request from untrusted origin',
    );
    res.status(403).json({ error: 'Forbidden origin' });
  };

  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (
      deps.isAuthorizedInternalBrowserApiRequest(req) ||
      deps.isAuthenticatedRequest(req)
    ) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized' });
  };

  return {
    requireTrustedOrigin,
    requireAuth,
  };
}

function createInternalApiProtectionMiddleware(): express.RequestHandler {
  return (req, res, next) => {
    if (isAuthorizedInternalApiRequest(req)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized' });
  };
}

const FEISHU_DOC_SERVICE_MODULE_ID = './feishu-doc-service.js';

async function loadCreateConversationFeishuDoc(): Promise<
  (
    input: CreateConversationFeishuDocInput,
  ) => Promise<CreateConversationFeishuDocResult>
> {
  const moduleId = FEISHU_DOC_SERVICE_MODULE_ID;
  const mod = (await import(moduleId)) as {
    createFeishuCloudDoc?: (
      input: CreateConversationFeishuDocInput,
    ) => Promise<CreateConversationFeishuDocResult>;
  };
  if (typeof mod.createFeishuCloudDoc !== 'function') {
    throw new Error('Feishu cloud doc service is not available');
  }
  return mod.createFeishuCloudDoc;
}

function parseIdentityNotes(notesJson: string): string[] {
  try {
    const parsed = JSON.parse(notesJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

async function mapIdentityAliases(
  personId: string,
): Promise<MemoryIdentityAlias[]> {
  return (await listIdentityAliases(personId)).map((alias) => ({
    channel: alias.channel,
    externalUserId: alias.external_user_id,
    displayName: alias.display_name,
  }));
}

async function mapIdentityProfile(input: {
  id: string;
  display_name: string;
  notes_json: string;
  created_at: string;
  updated_at: string;
}): Promise<MemoryIdentityProfile> {
  return {
    id: input.id,
    displayName: input.display_name,
    notes: parseIdentityNotes(input.notes_json),
    aliases: await mapIdentityAliases(input.id),
    createdAt: input.created_at,
    updatedAt: input.updated_at,
  };
}

function createDbBackedMemoryIdentityRepository(): MemoryIdentityRepository {
  return {
    async listProfiles(): Promise<MemoryIdentityProfile[]> {
      return Promise.all(
        (await listPersonProfiles()).map((profile) =>
          mapIdentityProfile(profile),
        ),
      );
    },
    async getProfile(id: string): Promise<MemoryIdentityProfile | null> {
      const profile = await getPersonProfile(id);
      return profile ? await mapIdentityProfile(profile) : null;
    },
    async createProfile(input): Promise<MemoryIdentityProfile> {
      const profile = await createPersonProfile({
        id: input.id,
        displayName: input.displayName,
        notes: input.notes,
        aliases: input.aliases,
      });
      return await mapIdentityProfile(profile);
    },
    async bindConversation(input) {
      const binding = await bindConversationIdentity(input);
      return {
        chatJid: binding.chat_jid,
        groupFolder: binding.group_folder,
        personId: binding.person_id,
        boundAt: binding.bound_at,
      };
    },
    async listBindingsForPerson(personId) {
      return (await listConversationIdentityBindingsForPerson(personId)).map(
        (binding) => ({
          chatJid: binding.chat_jid,
          groupFolder: binding.group_folder,
          personId: binding.person_id,
          boundAt: binding.bound_at,
        }),
      );
    },
  };
}

export function createWebServer(opts: WebServerOptions) {
  const app = express();
  app.use(localeMiddleware);
  app.use(createHttpRequestLoggingMiddleware());
  app.use((req, _res, next) => {
    const host = req.get('x-forwarded-host') || req.get('host');
    if (host) {
      const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
      setDetectedBaseUrl(`${proto}://${host}`);
    }
    next();
  });

  registerPublicHealthRoutes(app);
  fs.mkdirSync(CHAT_UPLOADS_ROOT, { recursive: true });
  const allowedConfigKeys = new Set<string>(WEB_CONFIG_KEYS);
  const uploadedFileSupport = createUploadedFileSupport({
    chatUploadsRoot: CHAT_UPLOADS_ROOT,
    maxUploadFilesPerRequest: MAX_UPLOAD_FILES_PER_REQUEST,
    maxUploadTextExcerptBytes: MAX_UPLOAD_TEXT_EXCERPT_BYTES,
    maxUploadTextExcerptChars: MAX_UPLOAD_TEXT_EXCERPT_CHARS,
  });
  startNonOverlappingBackgroundLoop({
    name: 'conversation-upload-cleanup',
    intervalMs: UPLOAD_CLEANUP_INTERVAL_MS,
    runImmediately: true,
    task: async () => {
      const summary = await uploadedFileSupport.cleanupOrphanUploadedFiles({
        maxAgeMs: ORPHAN_UPLOAD_MAX_AGE_MS,
      });
      if (summary.deletedFiles.length > 0) {
        logger.info(
          { deletedFiles: summary.deletedFiles.length },
          'conversation upload cleanup removed orphan files',
        );
      }
    },
  });
  const conversationAdminSupport = createConversationAdminSupport();
  const resetConversationRuntimeWithApprovalCleanup = (
    jid: string,
    groupFolder?: string,
  ) => {
    conversationAdminSupport.clearRuntimeApprovalPatchesForConversation(jid);
    opts.resetConversationRuntime?.(jid, groupFolder);
  };
  const decorateConversationSummary = createConversationSummaryDecorator({
    getConfiguredChannelInstances,
    getConversationLastEventSeq,
  });
  const getSanitizedWebConfigForApi = () =>
    getSanitizedWebConfig(SENSITIVE_CONFIG_KEYS) as Promise<
      Record<string, string>
    >;
  const auditMutation = createAuditMutation({
    logger,
    getAuthenticatedUsername,
    getRequestClientKey,
    recordAuditLog,
  });
  const persistSlashCommandManagedMcpServers = async (
    servers: Array<{
      id: string;
      enabled: boolean;
      name?: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
    }>,
  ) => {
    await persistManagedMcpServersService(
      servers.map((server) => ({
        ...server,
        name: server.name?.trim() || server.id,
        env: server.env || {},
      })),
    );
  };
  const slashCommandExecutor = createSlashCommandExecutor({
    refreshTaskSnapshots: opts.refreshTaskSnapshots,
    getManagedSkillsForResponse: getManagedSkillsForResponseService,
    getManagedMcpServersForResponse: getManagedMcpServersForResponseService,
    persistManagedMcpServers: persistSlashCommandManagedMcpServers,
    installManagedMcpServerFromInput: installManagedMcpServerFromInputService,
    installCustomSkillFromPath: installCustomSkillFromPathService,
    createSkillWithAiFromInput: createManagedSkillWithAiFromInput,
    deriveTaskTitle,
    generateAiTaskDraft,
  });

  const { requireTrustedOrigin, requireAuth } = createApiProtectionMiddleware({
    hasTrustedOrigin,
    isUnsafeMethod,
    isAuthorizedInternalBrowserApiRequest,
    isAuthenticatedRequest,
    logger,
  });
  const requireInternalApi = createInternalApiProtectionMiddleware();
  const createConversationFeishuDoc = async (
    input: CreateConversationFeishuDocInput,
  ): Promise<CreateConversationFeishuDocResult> => {
    if (opts.createConversationFeishuDoc) {
      return await Promise.resolve(opts.createConversationFeishuDoc(input));
    }
    const createFeishuCloudDoc = await loadCreateConversationFeishuDoc();
    return await createFeishuCloudDoc(input);
  };

  // Internal loopback APIs rely on JSON request bodies. Register the parser
  // before mounting those routes so MCP/tool POST calls always see req.body.
  app.use(
    express.json({
      limit: DEFAULT_JSON_BODY_LIMIT,
      verify: captureWhatsAppWebhookRawBody,
    }),
  );

  registerInternalMemoryRoutes(app, {
    requireInternalApi,
  });
  registerInternalReviewRoutes(app, {
    requireInternalApi,
  });
  registerInternalKnowledgeRoutes(app, {
    requireInternalApi,
  });

  // Serve React frontend
  const webDistPath = path.join(process.cwd(), 'web', 'dist');
  app.use(
    express.static(webDistPath, {
      setHeaders: (res, filePath) => {
        if (path.basename(filePath) === 'index.html') {
          res.setHeader(
            'Cache-Control',
            'no-store, no-cache, must-revalidate, proxy-revalidate',
          );
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
          res.setHeader('Surrogate-Control', 'no-store');
        }
      },
    }),
  );

  registerWhatsAppWebhookRoutes(app);
  registerRepoReviewIngressRoutes(app);

  app.use('/api', requireTrustedOrigin);
  app.use(
    '/api',
    createRateLimitMiddleware({ windowMs: 60_000, maxRequests: 120 }),
  );
  registerAuthRoutes(app, {
    loginThrottle,
    authSessions: {
      create: (u: string) => getAuthSessions().create(u),
      revoke: (t?: string) => getAuthSessions().revoke(t),
    },
    isLoginEnabled,
    isRegistrationEnabled,
    isAuthenticatedRequest,
    getRequestClientKey,
    getLoginCredentials,
    getAuthenticatedUsername,
  });

  registerPublicShareRoutes(app);

  app.use('/api', requireAuth);

  // Inject tenant context: resolve authenticated username to user_id.
  // Only look up real user IDs when multi-user mode is active (users
  // table has entries).  In single-user / admin-only mode every request
  // runs under SYSTEM_USER_ID so existing conversations stay visible.
  const tenantUserCache = new Map<
    string,
    { userId: string; expiresAt: number }
  >();
  const TENANT_CACHE_TTL_MS = 60_000;

  app.use('/api', (req, res, next) => {
    const username = getAuthenticatedUsername(req.headers.cookie);
    if (!username) {
      (req as express.Request & { tenantUserId?: string }).tenantUserId =
        SYSTEM_USER_ID;
      runWithTenant({ userId: SYSTEM_USER_ID }, () => next());
      return;
    }

    const now = Date.now();
    const cached = tenantUserCache.get(username);
    if (cached && cached.expiresAt > now) {
      (req as express.Request & { tenantUserId?: string }).tenantUserId =
        cached.userId;
      runWithTenant({ userId: cached.userId }, () => next());
      return;
    }

    isMultiUserMode()
      .then((multi) => {
        if (!multi) {
          tenantUserCache.set(username, {
            userId: SYSTEM_USER_ID,
            expiresAt: now + TENANT_CACHE_TTL_MS,
          });
          (req as express.Request & { tenantUserId?: string }).tenantUserId =
            SYSTEM_USER_ID;
          runWithTenant({ userId: SYSTEM_USER_ID }, () => next());
          return;
        }
        return getUserByUsername(username).then((user) => {
          if (!user || user.status !== 'active') {
            logger.warn(
              { username },
              'Tenant resolution failed: user not found or inactive in multi-user mode',
            );
            res.status(403).json({ error: 'User not found' });
            return;
          }
          tenantUserCache.set(username, {
            userId: user.id,
            expiresAt: now + TENANT_CACHE_TTL_MS,
          });
          (req as express.Request & { tenantUserId?: string }).tenantUserId =
            user.id;
          runWithTenant({ userId: user.id }, () => next());
        });
      })
      .catch((err) => {
        logger.error({ err }, 'Tenant resolution failed');
        res.status(500).json({ error: 'Internal error' });
      });
  });

  const { requirePermission } = createPermissionMiddleware({
    getAuthenticatedUsername,
  });
  const requireLocalCapability = createLocalCapabilityMiddleware({
    getAuthenticatedUsername,
  });
  registerUserRoutes(app, { requirePermission });
  registerResourceAccessRoutes(app, { requirePermission });
  registerImFriendRoutes(app, { getAuthenticatedUsername, requirePermission });
  registerImRoutes(app, { getAuthenticatedUsername, requirePermission });
  registerImGroupRoutes(app, { getAuthenticatedUsername, requirePermission });
  const imStorage = new LocalFileStorage(IM_UPLOADS_ROOT);
  registerImFileRoutes(app, {
    storage: imStorage,
    fileTtlMs: IM_FILE_TTL_MS,
    requirePermission,
  });
  startImFileCleanup(imStorage);
  registerSoulRoutes(app, { getAuthenticatedUsername, requirePermission });
  registerTavernRoutes(app, {
    requirePermission,
    listAvailableManagedSkills: getManagedSkillsForResponseService,
    listAvailableManagedMcpServers: getManagedMcpServersForResponseService,
  });
  registerPromptRoutes(app, { requirePermission, auditMutation });
  registerKnowledgeRoutes(app, { requirePermission });
  registerUserProviderRoutes(app, { requirePermission });
  registerAvailableProviderRoutes(app, { requirePermission });
  registerChannelInstanceRoutes(app, { requirePermission });
  registerLive2DRoutes(app, { requirePermission });
  registerUserMcpRoutes(app, { requirePermission, requireLocalCapability });
  registerUserSkillRoutes(app, { requirePermission, requireLocalCapability });
  registerPublicLibraryRoutes(app, {
    requirePermission,
    requireLocalCapability,
  });
  registerAdminMarketplaceRoutes(app, { requirePermission });
  registerAdminTrashRoutes(app, { requirePermission });
  registerAdminAuditRoutes(app, { requirePermission });
  registerRegistryRoutes(app, { requirePermission, requireLocalCapability });

  const memoryIdentityService = createMemoryIdentityService(
    createDbBackedMemoryIdentityRepository(),
  );
  registerSystemReadRoutes(app, {
    getSanitizedWebConfig: getSanitizedWebConfigForApi,
    getChannelStatus: opts.getChannelStatus,
    getAgentStatus: opts.getAgentStatus,
    isStockAnalysisEnabled: async () =>
      isFeatureEnabled(await getConfigValue('WEB_STOCK_ANALYSIS_ENABLED')),
    isWebTerminalEnabled: async () =>
      isFeatureEnabled(await getConfigValue('WEB_TERMINAL_ENABLED')),
    getLocalCapabilities: async (cookie?: string) =>
      resolveLocalCapabilitiesForUsername(getAuthenticatedUsername(cookie), {
        terminal: {
          configEnabled: isWebTerminalEnabled(),
        },
      }),
    requirePermission,
  });
  registerMemoryIdentityRoutes(app, {
    requirePermission,
    service: memoryIdentityService,
    auditMutation,
  });
  registerBrowserRoutes(app, { requirePermission, requireLocalCapability });

  registerAdminSettingsRoutes(app, {
    requirePermission,
    auditMutation,
    allowedConfigKeys,
    sensitiveConfigKeys: SENSITIVE_CONFIG_KEYS,
    applyProcessConfigSideEffects,
    summarizeConfigEffects,
    isAuthenticatedRequest,
    clearBootstrapCredentials,
    authSessions: {
      revokeAll: () => getAuthSessions().revokeAll(),
      create: (u: string) => getAuthSessions().create(u),
    },
    getLoginCredentials,
    serializeAuthCookie,
    normalizeCodexApiBase,
    readFirstCodexChatCompletionText,
    reloadChannels:
      opts.reloadChannels ??
      (async () => ({
        disconnected: [],
        connected: [],
        errors: ['reloadChannels not available'],
      })),
  });

  registerRuntimeCustomizationRoutes(app, {
    requirePermission,
    requireLocalCapability,
    auditMutation,
    getManagedMcpServersForResponse: getManagedMcpServersForResponseService,
    persistManagedMcpServers: persistManagedMcpServersService,
    installManagedMcpServerFromInput: installManagedMcpServerFromInputService,
    getManagedSkillsForResponse: getManagedSkillsForResponseService,
    getManagedSkillDetailForResponse: getManagedSkillDetailForResponseService,
    installCustomSkillFromPath: installCustomSkillFromPathService,
    createSkillWithAiFromInput: createManagedSkillWithAiFromInput,
    getExtensionMarketplaceSourcesForResponse:
      getExtensionMarketplaceSourcesForResponseService,
    persistExtensionMarketplaceSources:
      persistExtensionMarketplaceSourcesService,
    getExtensionMarketplaceCatalog: getExtensionMarketplaceCatalogService,
    getExtensionInstallsForResponse: getExtensionInstallsForResponseService,
    installMarketplaceExtensionFromInput:
      installMarketplaceExtensionFromInputService,
    importExtensionFromInput: importExtensionFromInputService,
    uninstallExtensionFromInput: uninstallExtensionFromInputService,
    reconcileExtensionInstalls: reconcileExtensionInstallsService,
  });
  registerAssistantRoutes(app, {
    requirePermission,
    auditMutation,
    listAvailableManagedSkills: getManagedSkillsForResponseService,
    listAvailableManagedMcpServers: getManagedMcpServersForResponseService,
    onAssistantMutated: async (assistantId) => {
      for (const conversation of await getConversationListByAssistantId(
        assistantId,
      )) {
        const groupFolder = (await getRegisteredGroup(conversation.jid))
          ?.folder;
        resetConversationRuntimeWithApprovalCleanup(
          conversation.jid,
          groupFolder,
        );
      }
    },
  });
  registerAssistantRepoRoutes(app, {
    requirePermission,
    auditMutation,
  });
  registerStockAnalysisRoutes(app, {
    requirePermission,
    auditMutation,
  });

  registerRepoReviewAdminRoutes(app, {
    auditMutation,
    getAuthenticatedUsername,
    requirePermission,
    requireLocalCapability,
  });
  registerRepositoryRoutes(app, { requirePermission, auditMutation });
  registerResourceBindingRoutes(app, { requirePermission, auditMutation });
  registerCodeSearchRoutes(app, {
    requirePermission,
    auditMutation,
  });
  registerCodeIndexRoutes(app, {
    requirePermission,
    auditMutation,
  });
  registerCodeMapRoutes(app, {
    requirePermission,
    auditMutation,
  });
  registerTaskSessionRoutes(app, {
    requirePermission,
    auditMutation,
    refreshTaskSnapshots: opts.refreshTaskSnapshots,
    runTaskNow: opts.runTaskNow,
    getTaskRuntimeState: opts.getTaskRuntimeState,
    clearCodexConversationState,
    deriveTaskTitle,
    generateAiTaskDraft,
  });

  registerWorkteamSupportRoutes(app, { requirePermission });
  registerWorkflowRoutes(app, { requirePermission, auditMutation });

  registerShareRoutes(app, { requirePermission });

  registerConversationAdminRoutes(app, {
    requirePermission,
    auditMutation,
    readPendingApprovalsForConversation:
      conversationAdminSupport.readPendingApprovalsForConversation,
    readActiveRuntimeApprovalPatchesForConversation:
      conversationAdminSupport.readActiveRuntimeApprovalPatchesForConversation,
    clearRuntimeApprovalPatchesForConversation:
      conversationAdminSupport.clearRuntimeApprovalPatchesForConversation,
    writeApprovalDecisionForConversation:
      conversationAdminSupport.writeApprovalDecisionForConversation,
    readPendingAsksForConversation: async (jid: string) => {
      const group = await getRegisteredGroup(jid);
      return group?.folder ? readPendingAsks(group.folder) : [];
    },
    writeAskAnswerForConversation: async (
      jid: string,
      askId: string,
      answer: string,
      answeredBy: string,
    ) => {
      const group = await getRegisteredGroup(jid);
      if (!group?.folder)
        throw new Error('Conversation group folder not found');
      writeAskResponse(group.folder, askId, answer, answeredBy);
    },
    interruptConversationReply: opts.interruptConversationReply,
    regenerateConversationReply: opts.regenerateConversationReply,
    updateConversationAccessPolicy: opts.updateConversationAccessPolicy,
    resetConversationRuntime: resetConversationRuntimeWithApprovalCleanup,
    clearCodexConversationState,
    getDefaultConversationAccessPolicy:
      conversationAdminSupport.getDefaultConversationAccessPolicy,
    normalizeAccessPolicyInput:
      conversationAdminSupport.normalizeAccessPolicyInput,
    normalizeAllowedDirectoriesInput:
      conversationAdminSupport.normalizeAllowedDirectoriesInput,
    createWebConversation: opts.createWebConversation,
    createChannelConversation: opts.createChannelConversation,
    createConversationFeishuDoc,
    setConversationProviderOverride: opts.setConversationProviderOverride,
  });
  registerConversationMemoryRoutes(app, {
    requirePermission,
    auditMutation,
  });

  registerConversationMessageRoutes(app, {
    requirePermission,
    decorateConversationSummary,
    parseBoundedInteger,
    defaultMessagePageSize: DEFAULT_MESSAGE_PAGE_SIZE,
    maxMessagePageSize: MAX_MESSAGE_PAGE_SIZE,
    readPendingApprovalsForConversation:
      conversationAdminSupport.readPendingApprovalsForConversation,
    parseUploadedFileContexts: uploadedFileSupport.parseUploadedFileContexts,
    buildUploadedFilesDisplayContent:
      uploadedFileSupport.buildUploadedFilesDisplayContent,
    toAgentUploadedFiles: uploadedFileSupport.toAgentUploadedFiles,
    persistWebCommandInboundMessage:
      slashCommandExecutor.persistWebCommandInboundMessage,
    executeSlashCommand: slashCommandExecutor.executeSlashCommand,
    persistWebCommandAssistantMessage:
      slashCommandExecutor.persistWebCommandAssistantMessage,
    formatSlashCommandResultOutput:
      slashCommandExecutor.formatSlashCommandResultOutput,
    refreshTaskSnapshots: opts.refreshTaskSnapshots,
    handleWebInput: opts.handleWebInput,
    parseUploadRequestFiles: uploadedFileSupport.parseUploadRequestFiles,
    resolveStoredUploadFile: uploadedFileSupport.resolveStoredUploadFile,
    resolveUploadRelativeRoot: uploadedFileSupport.resolveUploadRelativeRoot,
    chatUploadsRoot: CHAT_UPLOADS_ROOT,
    maxUploadBytesPerFile: MAX_UPLOAD_BYTES_PER_FILE,
    sanitizeUploadFileName: uploadedFileSupport.sanitizeUploadFileName,
    buildTextExcerpt: uploadedFileSupport.buildTextExcerpt,
    selectDirectoryNative,
    getAuthenticatedUsername,
  });

  // ── REST API ──

  // SPA fallback (Express v5 requires named param instead of bare *)
  app.get('{*path}', (_req, res) => {
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate',
    );
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.sendFile(path.join(webDistPath, 'index.html'), (err) => {
      if (err) res.status(404).send('Not found — run: cd web && npm run build');
    });
  });

  // ── HTTP + WebSocket ──

  const server = createServer(app);

  // Use noServer mode to manually route upgrades (prevents multi-WSS conflicts)
  const wss = new WebSocketServer({ noServer: true });
  const terminalWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(
      request.url ?? '/',
      `http://${request.headers.host}`,
    ).pathname;

    if (pathname === '/ws') {
      if (
        !isTrustedRequestOrigin(request.headers.origin, request.headers.host)
      ) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (
        isLoginEnabled() &&
        !getAuthenticatedUsername(request.headers.cookie)
      ) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/terminal') {
      if (
        !isTrustedRequestOrigin(request.headers.origin, request.headers.host)
      ) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      const termUser = getAuthenticatedUsername(request.headers.cookie);
      if (isLoginEnabled() && !termUser) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      void (async () => {
        try {
          const terminalCapability = await resolveLocalCapability('terminal', {
            username: termUser,
            configEnabled: isWebTerminalEnabled(),
          });
          if (!terminalCapability.available) {
            const status = getLocalCapabilityHttpStatus(terminalCapability);
            const label =
              status === 404
                ? '404 Not Found'
                : status === 401
                  ? '401 Unauthorized'
                  : '403 Forbidden';
            socket.write(`HTTP/1.1 ${label}\r\n\r\n`);
            socket.destroy();
            return;
          }
          terminalWss.handleUpgrade(request, socket, head, (ws) => {
            terminalWss.emit('connection', ws, request);
          });
        } catch {
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        }
      })();
    } else {
      socket.destroy();
    }
  });

  attachTerminalWebSocketHandler(terminalWss, {
    resolveSocketTenantUserId: async (cookie?: string) => {
      const username = getAuthenticatedUsername(cookie);
      if (!username) return SYSTEM_USER_ID;
      const multi = await isMultiUserMode();
      if (!multi) return SYSTEM_USER_ID;
      const user = await getUserByUsername(username);
      if (!user || user.status !== 'active')
        throw new Error(
          `WebSocket tenant: user '${username}' not found or inactive`,
        );
      return user.id;
    },
    getConversationRuntime: async (jid) => {
      const group = await getRegisteredGroup(jid);
      if (!group?.folder) return null;

      const defaultPolicy =
        await conversationAdminSupport.getDefaultConversationAccessPolicy();
      const conversationPolicy = group.agentConfig
        ? resolveLegacyAccessPolicy(group.agentConfig, {
            defaultMode: defaultPolicy.mode,
          })
        : null;
      const resolved = resolveConversationAccessState({
        defaultPolicy,
        conversationPolicy,
      });

      return {
        jid,
        groupFolder: group.folder,
        accessMode: resolved.policy.mode,
        allowedDirectories: resolved.policy.directories,
        runtimeApprovalPatches:
          conversationAdminSupport.readActiveRuntimeApprovalPatchesForConversation(
            jid,
          ),
      };
    },
  });
  attachRealtimeWebSocketHandler(wss, {
    refreshTaskSnapshots: opts.refreshTaskSnapshots,
    executeSlashCommand: slashCommandExecutor.executeSlashCommand,
    persistWebCommandInboundMessage:
      slashCommandExecutor.persistWebCommandInboundMessage,
    persistWebCommandAssistantMessage:
      slashCommandExecutor.persistWebCommandAssistantMessage,
    formatSlashCommandResultOutput:
      slashCommandExecutor.formatSlashCommandResultOutput,
    resolveSocketTenantUserId: async (cookie?: string) => {
      const username = getAuthenticatedUsername(cookie);
      if (!username) return SYSTEM_USER_ID;
      const multi = await isMultiUserMode();
      if (!multi) return SYSTEM_USER_ID;
      const user = await getUserByUsername(username);
      if (!user || user.status !== 'active')
        throw new Error(
          `WebSocket tenant: user '${username}' not found or inactive`,
        );
      return user.id;
    },
  });

  const browserService = getBrowserService();
  server.on('close', () => {
    void browserService.stop().catch((err) => {
      logger.warn(
        { err },
        'Failed to stop managed browser during web server shutdown',
      );
    });
  });

  return {
    server,
    wss,
    start: () => {
      return new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          if (err.code === 'EADDRINUSE') {
            logger.error(
              { port: opts.port },
              'Port in use; web UI cannot start. Stop the old process first or change WEB_PORT.',
            );
          } else {
            logger.error({ err }, 'Web server error');
          }
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          server.on('error', (err) => {
            logger.error({ err }, 'Web server error');
          });
          logger.info(
            { port: opts.port, url: `http://localhost:${opts.port}` },
            'Web server started',
          );
          recoverActiveRuns()
            .then((n) => {
              if (n)
                logger.info(
                  { recovered: n },
                  'workteam: recovered active runs after restart',
                );
            })
            .catch((err) =>
              logger.warn({ err }, 'workteam: run recovery failed'),
            );
          recoverActiveWorkflowRuns()
            .then((n) => {
              if (n)
                logger.info(
                  { recovered: n },
                  'workflow: recovered active runs after restart',
                );
            })
            .catch((err) =>
              logger.warn({ err }, 'workflow: run recovery failed'),
            );
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(opts.port);
      });
    },
  };
}
