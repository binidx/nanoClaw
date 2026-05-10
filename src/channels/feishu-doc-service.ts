import {
  type FeishuDocAuthorizationTargetResult,
  type FeishuDocSection,
  createFeishuDocByJid,
  getFeishuChatContextByJid,
  grantFeishuDocToChatByJid,
  grantFeishuDocToUsersByJid,
  populateFeishuDocByJid,
  resolveFeishuDmCounterpartOpenIdByJid,
  resolveFeishuDocUrlByJid,
} from './feishu.js';

export interface FeishuDocCreateRequest {
  chatJid: string;
  title: string;
  conversationType: 'group' | 'dm';
  sections: FeishuDocSection[];
  idempotencyKey?: string;
}

export interface FeishuDocPrepareRequest {
  chatJid: string;
  title: string;
  conversationType: 'group' | 'dm';
  idempotencyKey?: string;
}

export interface FeishuDocContinueRequest {
  chatJid: string;
  documentId: string;
  title: string;
  conversationType: 'group' | 'dm';
  sections: FeishuDocSection[];
  idempotencyKey?: string;
}

export interface FeishuDocCreateResult {
  documentId: string;
  url: string;
  title: string;
  conversationType: 'group' | 'dm';
  creationStatus: 'created' | 'failed';
  populationStatus: 'pending' | 'completed' | 'failed';
  resultStatus:
    | 'success'
    | 'success_with_authorization_warnings'
    | 'content_population_failed'
    | 'creation_failed'
    | 'url_resolution_failed';
  authorizationStrategy: 'chat' | 'users';
  authorizationStatus: 'complete' | 'partial' | 'failed' | 'skipped';
  authorizationWarnings: string[];
  targetResults: FeishuDocAuthorizationTargetResult[];
  lastError?: string;
}

interface FeishuDocAuthorizationResult {
  authorizationStrategy: 'chat' | 'users';
  authorizationStatus: 'complete' | 'partial' | 'failed';
  warnings: string[];
  targets: FeishuDocAuthorizationTargetResult[];
}

function defaultAuthorizationStrategy(
  conversationType: 'group' | 'dm',
): 'chat' | 'users' {
  return conversationType === 'group' ? 'chat' : 'users';
}

async function validateFeishuConversationType(
  request: Pick<FeishuDocCreateRequest, 'chatJid' | 'conversationType'>,
): Promise<Awaited<ReturnType<typeof getFeishuChatContextByJid>>> {
  if (!request.conversationType) {
    throw new Error('Feishu conversation type is required');
  }
  const context = await getFeishuChatContextByJid(request.chatJid);
  const actualConversationType = context.isGroup ? 'group' : 'dm';
  if (actualConversationType !== request.conversationType) {
    throw new Error(
      `Feishu conversation type mismatch: expected ${request.conversationType}, got ${actualConversationType}`,
    );
  }
  return context;
}

async function applyFeishuDocAuthorization(
  request: FeishuDocCreateRequest,
  documentId: string,
  context: Awaited<ReturnType<typeof getFeishuChatContextByJid>>,
): Promise<FeishuDocAuthorizationResult> {
  if (request.conversationType === 'group') {
    try {
      return await grantFeishuDocToChatByJid(request.chatJid, {
        documentId,
        chatId: context.chatId,
        perm: 'edit',
      });
    } catch (_error) {
      const fallback = await grantFeishuDocToUsersByJid(request.chatJid, {
        documentId,
        openIds: context.participantOpenIds,
        perm: 'edit',
      });
      return {
        authorizationStrategy: fallback.authorizationStrategy,
        authorizationStatus: fallback.authorizationStatus,
        warnings: [
          fallback.authorizationStatus === 'complete'
            ? 'chat grant failed; user fallback used'
            : fallback.authorizationStatus === 'partial'
              ? 'chat grant failed; user fallback partially failed'
              : context.participantOpenIds.length === 0
                ? 'chat grant failed; no group members were resolved for fallback authorization'
                : 'chat grant failed; user fallback failed',
          ...fallback.warnings,
        ],
        targets: fallback.targets,
      };
    }
  }

  const counterpartOpenId = await resolveFeishuDmCounterpartOpenIdByJid(
    request.chatJid,
  );
  const dmGrant = await grantFeishuDocToUsersByJid(request.chatJid, {
    documentId,
    openIds: [counterpartOpenId],
    perm: 'edit',
  });
  return {
    authorizationStrategy: dmGrant.authorizationStrategy,
    authorizationStatus: dmGrant.authorizationStatus,
    warnings: dmGrant.warnings,
    targets: dmGrant.targets,
  };
}

export async function prepareFeishuCloudDoc(
  request: FeishuDocPrepareRequest,
): Promise<{ documentId: string; title: string; creationStatus: 'created' }> {
  await validateFeishuConversationType(request);
  try {
    const created = await createFeishuDocByJid(request.chatJid, {
      title: request.title,
    });
    return {
      documentId: created.documentId,
      title: created.title,
      creationStatus: 'created',
    };
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error(String(error || 'Feishu cloud doc creation failed'));
  }
}

export async function continueFeishuCloudDocProvision(
  request: FeishuDocContinueRequest,
): Promise<FeishuDocCreateResult> {
  const context = await validateFeishuConversationType(request);
  try {
    await populateFeishuDocByJid(request.chatJid, {
      documentId: request.documentId,
      sections: request.sections,
    });
  } catch (error) {
    const lastError =
      error instanceof Error
        ? error.message
        : String(error || 'Feishu doc content population failed');
    return {
      documentId: request.documentId,
      url: '',
      title: request.title,
      conversationType: request.conversationType,
      creationStatus: 'created',
      populationStatus: 'failed',
      resultStatus: 'content_population_failed',
      authorizationStrategy: defaultAuthorizationStrategy(
        request.conversationType,
      ),
      authorizationStatus: 'skipped',
      authorizationWarnings: [],
      targetResults: [],
      lastError,
    };
  }

  let url = '';
  try {
    url = await resolveFeishuDocUrlByJid(request.chatJid, {
      documentId: request.documentId,
    });
  } catch (error) {
    const lastError =
      error instanceof Error
        ? error.message
        : String(error || 'Feishu doc URL resolution failed');
    return {
      documentId: request.documentId,
      url: '',
      title: request.title,
      conversationType: request.conversationType,
      creationStatus: 'created',
      populationStatus: 'completed',
      resultStatus: 'url_resolution_failed',
      authorizationStrategy: defaultAuthorizationStrategy(
        request.conversationType,
      ),
      authorizationStatus: 'skipped',
      authorizationWarnings: [],
      targetResults: [],
      lastError,
    };
  }

  try {
    const authorization = await applyFeishuDocAuthorization(
      request,
      request.documentId,
      context,
    );
    const resultStatus =
      authorization.authorizationStatus === 'complete'
        ? 'success'
        : 'success_with_authorization_warnings';

    return {
      documentId: request.documentId,
      url,
      title: request.title,
      conversationType: request.conversationType,
      creationStatus: 'created',
      populationStatus: 'completed',
      resultStatus,
      authorizationStrategy: authorization.authorizationStrategy,
      authorizationStatus: authorization.authorizationStatus,
      authorizationWarnings: authorization.warnings,
      targetResults: authorization.targets,
    };
  } catch (error) {
    const warning =
      error instanceof Error ? error.message : String(error || 'Authorization failed');
    return {
      documentId: request.documentId,
      url,
      title: request.title,
      conversationType: request.conversationType,
      creationStatus: 'created',
      populationStatus: 'completed',
      resultStatus: 'success_with_authorization_warnings',
      authorizationStrategy: defaultAuthorizationStrategy(
        request.conversationType,
      ),
      authorizationStatus: 'failed',
      authorizationWarnings: [warning],
      targetResults: [],
      lastError: warning,
    };
  }
}

export async function createFeishuCloudDoc(
  request: FeishuDocCreateRequest,
): Promise<FeishuDocCreateResult> {
  if (!request.conversationType) {
    throw new Error('Feishu conversation type is required');
  }

  let prepared: Awaited<ReturnType<typeof prepareFeishuCloudDoc>>;
  try {
    prepared = await prepareFeishuCloudDoc({
      chatJid: request.chatJid,
      title: request.title,
      conversationType: request.conversationType,
      idempotencyKey: request.idempotencyKey,
    });
  } catch (_error) {
    return {
      documentId: '',
      url: '',
      title: request.title,
      conversationType: request.conversationType,
      creationStatus: 'failed',
      populationStatus: 'pending',
      resultStatus: 'creation_failed',
      authorizationStrategy: defaultAuthorizationStrategy(
        request.conversationType,
      ),
      authorizationStatus: 'skipped',
      authorizationWarnings: [],
      targetResults: [],
      lastError:
        _error instanceof Error
          ? _error.message
          : String(_error || 'Feishu cloud doc creation failed'),
    };
  }

  return await continueFeishuCloudDocProvision({
    chatJid: request.chatJid,
    documentId: prepared.documentId,
    title: prepared.title,
    conversationType: request.conversationType,
    sections: request.sections,
    idempotencyKey: request.idempotencyKey,
  });
}
