#!/usr/bin/env node
/**
 * Fix remaining 50 TypeScript compilation errors in db.ts.
 *
 * Three categories:
 *   A) Missing `await` on async function calls (properties accessed on Promise)
 *   B) `return [await] func()!` where `!` applies to Promise, not resolved value
 *   C) Pure functions incorrectly marked async / with Promise return type
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbFile = resolve(__dirname, '..', 'src', 'db.ts');
let code = readFileSync(dbFile, 'utf8');
let changes = 0;

function replace(old, nw, label) {
  if (!code.includes(old)) {
    console.warn(`[SKIP] Not found: ${label}`);
    return;
  }
  const idx = code.indexOf(old);
  const secondIdx = code.indexOf(old, idx + old.length);
  if (secondIdx !== -1 && !label.startsWith('MULTI:')) {
    console.warn(`[WARN] Multiple matches for: ${label}`);
  }
  code = code.replace(old, nw);
  changes++;
  console.log(`[OK] ${label}`);
}

function replaceAll(old, nw, label) {
  let count = 0;
  while (code.includes(old)) {
    code = code.replace(old, nw);
    count++;
  }
  if (count > 0) {
    changes += count;
    console.log(`[OK] ${label} (${count}x)`);
  } else {
    console.warn(`[SKIP] Not found: ${label}`);
  }
}

// ── Category C: Pure functions incorrectly async ───────────────────

// C1: normalizeIdentityAliases - not async, but return type has Promise<>
replace(
  `): Promise<Array<{
  channel: string | null;
  externalUserId: string | null;
  displayName: string | null;
}>> {`,
  `): Array<{
  channel: string | null;
  externalUserId: string | null;
  displayName: string | null;
}> {`,
  'C1: normalizeIdentityAliases return type'
);

// C2: normalizeAssistantSummary - pure transform, no await needed
replace(
  'async function normalizeAssistantSummary(record: AssistantRecord): Promise<AssistantSummary> {',
  'function normalizeAssistantSummary(record: AssistantRecord): AssistantSummary {',
  'C2: normalizeAssistantSummary revert to sync'
);

// ── Category A: Missing await on async function calls ──────────────

// A1: listIdentityAliases in createPersonProfile
replace(
  'aliases: listIdentityAliases(created.id).map((alias) => ({',
  'aliases: (await listIdentityAliases(created.id)).map((alias) => ({',
  'A1: await listIdentityAliases in createPersonProfile'
);

// A2: listIdentityAliases in updatePersonProfile
replace(
  'await listIdentityAliases(existing.id).map((alias) => ({',
  '(await listIdentityAliases(existing.id)).map((alias) => ({',
  'A2: await listIdentityAliases in updatePersonProfile'
);

// A3: getAllTasks().map in getLatestTaskRunLogs
replace(
  'return await getLatestTaskRunLogsForTaskIds(getAllTasks().map((task) => task.id));',
  'return await getLatestTaskRunLogsForTaskIds((await getAllTasks()).map((task) => task.id));',
  'A3: await getAllTasks in getLatestTaskRunLogs'
);

// A4: getConversationList().filter in getConversationListByAssistantId
replace(
  'return await getConversationList().filter(',
  'return (await getConversationList()).filter(',
  'A4: await getConversationList in getConversationListByAssistantId'
);

// A5: getStockAnalysisConfigState().version in getStockAnalysisConfigVersion
replace(
  'return String(getStockAnalysisConfigState().version);',
  'return String((await getStockAnalysisConfigState()).version);',
  'A5: await getStockAnalysisConfigState in getStockAnalysisConfigVersion'
);

// A6: Missing await in updateStockAnalysisConfigEntries transaction
replace(
  `const currentVersion = getStockAnalysisConfigVersion();
    if (input.expectedVersion && input.expectedVersion !== currentVersion) {
      throw new Error('配置已变化，请刷新后重试');
    }

    let changed = false;

    for (const key of input.deleteKeys) {
      const result = db
        .prepare('DELETE FROM stock_analysis_config WHERE key = ?')
        .run(key);`,
  `const currentVersion = await getStockAnalysisConfigVersion();
    if (input.expectedVersion && input.expectedVersion !== currentVersion) {
      throw new Error('配置已变化，请刷新后重试');
    }

    let changed = false;

    for (const key of input.deleteKeys) {
      const result = await dba.prepare('DELETE FROM stock_analysis_config WHERE key = ?')
        .run(key);`,
  'A6: await in updateStockAnalysisConfigEntries (currentVersion + delete)'
);

// A6b: fix db.prepare SELECT in same function
replace(
  `const existing = db
        .prepare('SELECT value FROM stock_analysis_config WHERE key = ?')
        .get(key) as { value: string } | undefined;`,
  `const existing = await dba.prepare('SELECT value FROM stock_analysis_config WHERE key = ?')
        .get(key) as { value: string } | undefined;`,
  'A6b: dba.prepare SELECT in updateStockAnalysisConfigEntries'
);

// A6c: await bumpStockAnalysisConfigVersion + createStockAnalysisConfigHistory
replace(
  `const nextVersion = bumpStockAnalysisConfigVersion(now);
    const historyId = createStockAnalysisConfigHistory(now, nextVersion, [
      ...new Set([...input.deleteKeys, ...Object.keys(input.setValues)]),
    ]);
    return { configVersion: nextVersion, historyId };
  });

  return apply();`,
  `const nextVersion = await bumpStockAnalysisConfigVersion(now);
    const historyId = await createStockAnalysisConfigHistory(now, nextVersion, [
      ...new Set([...input.deleteKeys, ...Object.keys(input.setValues)]),
    ]);
    return { configVersion: nextVersion, historyId };
  });

  return apply();`,
  'A6c: await bump + createHistory in updateStockAnalysisConfigEntries'
);

// A7: Missing await in restoreStockAnalysisConfigHistory transaction
replace(
  `const currentVersion = getStockAnalysisConfigVersion();
    if (input.expectedVersion && input.expectedVersion !== currentVersion) {
      throw new Error('配置已变化，请刷新后重试');
    }

    const snapshot = getStockAnalysisConfigHistory(input.id);`,
  `const currentVersion = await getStockAnalysisConfigVersion();
    if (input.expectedVersion && input.expectedVersion !== currentVersion) {
      throw new Error('配置已变化，请刷新后重试');
    }

    const snapshot = await getStockAnalysisConfigHistory(input.id);`,
  'A7: await in restoreStockAnalysisConfigHistory (currentVersion + snapshot)'
);

// A7b: await bump + createHistory in restoreStockAnalysisConfigHistory
replace(
  `const nextVersion = bumpStockAnalysisConfigVersion(now);
    const historyId = createStockAnalysisConfigHistory(
      now,
      nextVersion,
      Array.from(changedKeys).sort(),
    );
    return { configVersion: nextVersion, historyId };
  });

  return apply();
}`,
  `const nextVersion = await bumpStockAnalysisConfigVersion(now);
    const historyId = await createStockAnalysisConfigHistory(
      now,
      nextVersion,
      Array.from(changedKeys).sort(),
    );
    return { configVersion: nextVersion, historyId };
  });

  return apply();
}`,
  'A7b: await bump + createHistory in restoreStockAnalysisConfigHistory'
);

// A8: getReviewProfileById missing await in saveReviewProfile
replace(
  '  const existing = getReviewProfileById(input.id);',
  '  const existing = await getReviewProfileById(input.id);',
  'A8: await getReviewProfileById in saveReviewProfile'
);

// A9: getReviewBranchState missing await in upsertReviewBranchState
replace(
  `const existing = getReviewBranchState({
    repositoryId: input.repository_id,
    stage: input.stage,
    branch: input.branch,
  });`,
  `const existing = await getReviewBranchState({
    repositoryId: input.repository_id,
    stage: input.stage,
    branch: input.branch,
  });`,
  'A9: await getReviewBranchState in upsertReviewBranchState'
);

// A10: getReviewConversationBindingByRepositoryId missing await
replace(
  `const existing = getReviewConversationBindingByRepositoryId(
    input.repository_id,
  );
  await dba.prepare(
    \`INSERT OR REPLACE INTO review_conversation_bindings (
      repository_id, chat_jid, created_at, updated_at
    ) VALUES (?, ?, ?, ?)\`,
  ).run(input.repository_id, input.chat_jid, existing?.created_at || now, now);`,
  `const existing = await getReviewConversationBindingByRepositoryId(
    input.repository_id,
  );
  await dba.prepare(
    \`INSERT OR REPLACE INTO review_conversation_bindings (
      repository_id, chat_jid, created_at, updated_at
    ) VALUES (?, ?, ?, ?)\`,
  ).run(input.repository_id, input.chat_jid, existing?.created_at || now, now);`,
  'A10: await getReviewConversationBindingByRepositoryId'
);

// A11: listTicketProfiles + deleteTicketRun/deleteTicketProfile missing await in deleteTicketWorkspace
replace(
  `const profiles = listTicketProfiles(id);
    const runs = db
      .prepare(\`SELECT id FROM ticket_runs WHERE workspace_id = ?\`)
      .all(id) as Array<{ id: string }>;
    for (const run of runs) {
      deleteTicketRun(run.id);
    }
    for (const profile of profiles) {
      deleteTicketProfile(profile.id);
    }`,
  `const profiles = await listTicketProfiles(id);
    const runs = await dba.prepare(\`SELECT id FROM ticket_runs WHERE workspace_id = ?\`)
      .all(id) as unknown as Array<{ id: string }>;
    for (const run of runs) {
      await deleteTicketRun(run.id);
    }
    for (const profile of profiles) {
      await deleteTicketProfile(profile.id);
    }`,
  'A11: await listTicketProfiles + deleteTicketRun/Profile in deleteTicketWorkspace'
);

// A12: getTicketProfileById missing await in saveTicketProfile
replace(
  '  const existing = getTicketProfileById(input.id);',
  '  const existing = await getTicketProfileById(input.id);',
  'A12: await getTicketProfileById in saveTicketProfile'
);

// A13: getTicketBindingById missing await in saveTicketBinding
replace(
  '  const existing = getTicketBindingById(input.id);',
  '  const existing = await getTicketBindingById(input.id);',
  'A13: await getTicketBindingById in saveTicketBinding'
);

// ── Category B: `return [await] func()!` → `return (await func())!` ──

// B1: getConversationIdentityBinding
replace(
  'return getConversationIdentityBinding(input.chatJid)!;',
  'return (await getConversationIdentityBinding(input.chatJid))!;',
  'B1: fix non-null assertion on getConversationIdentityBinding'
);

// B2: getAssistant
replace(
  'return await getAssistant(id)!;',
  'return (await getAssistant(id))!;',
  'B2: fix non-null assertion on getAssistant'
);

// B3: getAssistantMcpBinding
replace(
  'return await getAssistantMcpBinding(assistantId, id)!;',
  'return (await getAssistantMcpBinding(assistantId, id))!;',
  'B3: fix non-null assertion on getAssistantMcpBinding'
);

// B4: getAssistantMcpBindingSecret
replace(
  'return await getAssistantMcpBindingSecret(assistantId, bindingId)!;',
  'return (await getAssistantMcpBindingSecret(assistantId, bindingId))!;',
  'B4: fix non-null assertion on getAssistantMcpBindingSecret'
);

// B5: getReviewRepositoryById
replace(
  'return await getReviewRepositoryById(input.id)!;',
  'return (await getReviewRepositoryById(input.id))!;',
  'B5: fix non-null assertion on getReviewRepositoryById'
);

// B6: getReviewProfileById return
replace(
  'return getReviewProfileById(input.id)!;',
  'return (await getReviewProfileById(input.id))!;',
  'B6: fix non-null assertion on getReviewProfileById'
);

// B7: getReviewRunById in createReviewRun
replace(
  'return await getReviewRunById(input.id)!;',
  'return (await getReviewRunById(input.id))!;',
  'MULTI:B7: fix non-null assertion on getReviewRunById (1)'
);

// B7b: getReviewRunById in updateReviewRun
replace(
  'return await getReviewRunById(id)!;',
  'return (await getReviewRunById(id))!;',
  'B7b: fix non-null assertion on getReviewRunById (2)'
);

// B7c: getReviewRunById in setReviewRunManualDecision
replace(
  'return await getReviewRunById(input.runId)!;',
  'return (await getReviewRunById(input.runId))!;',
  'B7c: fix non-null assertion on getReviewRunById (3)'
);

// B8: getReviewBranchState return in upsertReviewBranchState
replace(
  `return getReviewBranchState({
    repositoryId: input.repository_id,
    stage: input.stage,
    branch: input.branch,
  })!;`,
  `return (await getReviewBranchState({
    repositoryId: input.repository_id,
    stage: input.stage,
    branch: input.branch,
  }))!;`,
  'B8: fix non-null assertion on getReviewBranchState'
);

// B9: getReviewConversationBindingByRepositoryId return
replace(
  'return getReviewConversationBindingByRepositoryId(input.repository_id)!;',
  'return (await getReviewConversationBindingByRepositoryId(input.repository_id))!;',
  'B9: fix non-null assertion on getReviewConversationBindingByRepositoryId'
);

// B10: getReviewRemoteBranchCache return
replace(
  'return getReviewRemoteBranchCache(input.repository_id)!;',
  'return (await getReviewRemoteBranchCache(input.repository_id))!;',
  'B10: fix non-null assertion on getReviewRemoteBranchCache'
);

// B11: getTicketCodeIndexRecord
replace(
  'return await getTicketCodeIndexRecord(input.cache_key)!;',
  'return (await getTicketCodeIndexRecord(input.cache_key))!;',
  'B11: fix non-null assertion on getTicketCodeIndexRecord'
);

// B12: getTicketWorkspaceById
replace(
  'return getTicketWorkspaceById(input.id)!;',
  'return (await getTicketWorkspaceById(input.id))!;',
  'B12: fix non-null assertion on getTicketWorkspaceById'
);

// B13: getTicketProfileById return
replace(
  'return getTicketProfileById(input.id)!;',
  'return (await getTicketProfileById(input.id))!;',
  'B13: fix non-null assertion on getTicketProfileById'
);

// B14: getTicketBindingById return
replace(
  'return getTicketBindingById(input.id)!;',
  'return (await getTicketBindingById(input.id))!;',
  'B14: fix non-null assertion on getTicketBindingById'
);

// B15: getTicketRunById in createTicketRun
replace(
  'return getTicketRunById(input.id)!;',
  'return (await getTicketRunById(input.id))!;',
  'MULTI:B15: fix non-null assertion on getTicketRunById (1)'
);

// B15b: getTicketRunById in updateTicketRun
replace(
  'return getTicketRunById(id)!;',
  'return (await getTicketRunById(id))!;',
  'B15b: fix non-null assertion on getTicketRunById (2)'
);

writeFileSync(dbFile, code, 'utf8');
console.log(`\nDone: ${changes} replacements applied`);
