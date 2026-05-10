import { readFileSync, writeFileSync } from 'fs';

let code = readFileSync('src/db.ts', 'utf8');

// Fix return type of normalizeIdentityAliases (not async anymore)
code = code.replace(
  /normalizeIdentityAliases\(\s*\n\s*aliases[^)]*\),?\n\): Promise<Array/,
  (m) => m.replace('Promise<Array', 'Array')
);

// Fix buildDeterministicContextCompactionSummary return type
code = code.replace(
  /buildDeterministicContextCompactionSummary\([^)]*\):\s*Promise<string>/g,
  (m) => m.replace('Promise<string>', 'string')
);

// Add await to more internal async function calls
const moreFns = [
  'normalizeIdentityAliases',
  'listIdentityAliases',
  'getDueTasks',
  'getAssistant',
  'getAssistantMcpBinding',
  'getAssistantMcpBindingSecret',
  'listAssistantMcpBindings',
  'listAssistantMcpBindingSecrets',
  'getAllRegisteredGroups',
  'getAllSessions',
  'getStockAnalysisConfigState',
  'getStockAnalysisConfigEntries',
  'getTaskById',
  'getTasksForGroup',
  'getTasksForChat',
  'getAllTasks',
  'getTaskSnapshots',
  'deleteTask',
  'claimTaskExecution',
  'updateTaskAfterRun',
  'logTaskRun',
  'getLatestTaskRunLogs',
  'getLatestTaskRunLogsForTaskIds',
  'getRouterState',
  'setRouterState',
  'getSession',
  'setSession',
  'createAssistant',
  'updateAssistant',
  'deleteAssistant',
  'createAssistantMcpBinding',
  'updateAssistantMcpBinding',
  'deleteAssistantMcpBinding',
  'upsertAssistantMcpBindingSecret',
  'deleteAssistantMcpBindingSecret',
  'getAllProviders',
  'getDefaultProvider',
  'getProviderById',
  'updateProvider',
  'getConversationList',
  'getConversationDetail',
  'getConversationMessages',
  'getMessageCount',
  'parseReviewProfileRecord',
  'parseReviewRepositoryRecord',
  'parseReviewRunRecord',
  'listReviewRepositories',
  'getReviewRepositoryById',
  'saveReviewRepository',
  'deleteReviewRepository',
  'getReviewProfilesByRepoId',
  'saveReviewProfile',
  'deleteReviewProfile',
  'listReviewRuns',
  'getReviewRunById',
  'saveReviewRun',
  'listTicketWorkspaces',
  'getTicketCodeIndexRecord',
  'getTicketCodeIndexSnapshot',
  'saveTicketCodeIndexSnapshot',
  'deleteTicketCodeIndexSnapshot',
  'parseTicketWorkspaceRecord',
  'parseTicketProfileRecord',
  'saveTicketWorkspace',
];

for (const fn of moreFns) {
  // Add await to assignments
  const assignRe = new RegExp(`((?:const|let|var)\\s+\\w+\\s*=\\s*)(?!await\\s)(${fn}\\()`, 'g');
  code = code.replace(assignRe, '$1await $2');

  // Add await to statement calls (function call at start of line)
  const stmtRe = new RegExp(`^(\\s+)(?!await\\s|return\\s|const |let |var )(${fn}\\()`, 'gm');
  code = code.replace(stmtRe, '$1await $2');

  // Add await after return
  const returnRe = new RegExp(`(return\\s+)(?!await\\s)(${fn}\\()`, 'g');
  code = code.replace(returnRe, '$1await $2');
}

// Fix type cast issues: "as TaskSnapshot[]" after dba.prepare().all()
// Promise<Record<string, unknown>[]> as TaskSnapshot[] → needs double cast
code = code.replace(
  /await dba\.prepare\(sql\)\.all\(groupFolder\) as TaskSnapshot\[\]/g,
  'await dba.prepare(sql).all(groupFolder) as unknown as TaskSnapshot[]'
);
code = code.replace(
  /await dba\.prepare\(sql\)\.all\(\) as TaskSnapshot\[\]/g,
  'await dba.prepare(sql).all() as unknown as TaskSnapshot[]'
);

writeFileSync('src/db.ts', code);
console.log('Internal await fixes v2 applied');
