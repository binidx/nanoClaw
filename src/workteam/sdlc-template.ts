import type {
  SmartCreatorResult,
  WorkteamRecord,
  WorkteamAgentRecord,
  WorkteamTaskRecord,
} from './types.js';
import { createTeamFromSmartResult } from './smart-creator.js';
import { updateWorkteamTask } from '../db/workteam.js';
import type { RunnerProfile } from './runner-profiles.js';
import { t } from '../i18n/index.js';

export interface SdlcTemplateOptions {
  repositoryId?: string;
  reviewRetries?: number;
  parallelModules?: string[];
  /**
   * When provided, the "测试验证" task's prompt hard-codes the profile's
   * `testCommand`, and the eval config's `required_patterns` include the
   * profile's `testSuccessPatterns`.
   */
  runnerProfile?: RunnerProfile;
}

export function buildSdlcTemplate(
  options: SdlcTemplateOptions = {},
): SmartCreatorResult {
  const repoContext = options.repositoryId
    ? t('workteam.repoIdTarget', { id: options.repositoryId }, undefined)
    : '';

  const agents: SmartCreatorResult['agents'] = [
    {
      role: 'product_manager',
      goal: t('workteam.auto_bf893b', {}, undefined),
      backstory: t('workteam.auto_cc9c14', {}, undefined),
    },
    {
      role: 'architect',
      goal: t('workteam.auto_128e66', {}, undefined),
      backstory: t('workteam.auto_ec69cb', {}, undefined),
    },
    {
      role: 'developer',
      goal: t('workteam.auto_15889e', {}, undefined),
      backstory: t('workteam.devBackstory', { context: repoContext }, undefined),
      model_preference: 'default',
    },
    {
      role: 'tester',
      goal: t('workteam.auto_a42d7c', {}, undefined),
      backstory: t('workteam.qaBackstory', { context: repoContext }, undefined),
    },
    {
      role: 'code_reviewer',
      goal: t('workteam.auto_d277c5', {}, undefined),
      backstory: t('workteam.reviewerBackstory', { context: repoContext }, undefined),
      model_preference: 'independent',
    },
  ];

  const tasks: SmartCreatorResult['tasks'] = [
    {
      name: t('workteam.auto_ad8b9e', {}, undefined),
      description:
        t('workteam.auto_e0076b', {}, undefined) +
        t('workteam.auto_a3f153', {}, undefined),
      expected_output: t('workteam.auto_28d354', {}, undefined),
      agent_role: 'product_manager',
      dependencies: [],
    },
    {
      name: t('workteam.auto_573b37', {}, undefined),
      description:
        t('workteam.auto_2c774d', {}, undefined) +
        t('workteam.auto_90b44c', {}, undefined),
      expected_output:
        t('workteam.auto_83fce8', {}, undefined),
      agent_role: 'product_manager',
      dependencies: [t('workteam.auto_ad8b9e', {}, undefined)],
    },
    {
      name: t('errors.auto_9890f8', {}, undefined),
      description:
        t('workteam.auto_069af0', {}, undefined),
      expected_output: t('workteam.auto_53694e', {}, undefined),
      agent_role: 'architect',
      dependencies: [t('workteam.auto_573b37', {}, undefined)],
    },
  ];

  const modules = options.parallelModules;
  const worktreeRequirement =
    t('workteam.auto_490d6b', {}, undefined) +
    t('workteam.auto_345cea', {}, undefined);

  if (modules && modules.length > 1) {
    for (const mod of modules) {
      tasks.push({
        name: t('workteam.devTaskName', { module: mod }, undefined),
        description: t('workteam.devTaskDesc', { module: mod, requirement: worktreeRequirement }, undefined),
        expected_output: t('workteam.devTaskOutput', { module: mod }, undefined),
        agent_role: 'developer',
        dependencies: [t('errors.auto_9890f8', {}, undefined)],
      });
    }
  } else {
    tasks.push({
      name: t('errors.auto_8d71e5', {}, undefined),
      description: t('workteam.devTaskDescSimple', { requirement: worktreeRequirement }, undefined),
      expected_output: t('workteam.devTaskOutputSimple', {}, undefined),
      agent_role: 'developer',
      dependencies: [t('errors.auto_9890f8', {}, undefined)],
    });
  }

  const devTaskNames = tasks
    .filter((task) => task.name.startsWith(t('errors.auto_8d71e5', {}, undefined)))
    .map((task) => task.name);

  const profile = options.runnerProfile;
  const testDescription = profile
    ? t('workteam.testTaskDesc', {
        name: profile.name,
        id: profile.id,
        command: profile.testCommand,
        patterns: profile.testSuccessPatterns.map((p) => `"${p}"`).join(t('workteam.patternSeparator', {}, undefined)),
      }, undefined)
    : t('workteam.auto_2b2673', {}, undefined);

  tasks.push(
    {
      name: t('workteam.auto_93289e', {}, undefined),
      description: testDescription,
      expected_output: t('workteam.auto_76a34a', {}, undefined),
      agent_role: 'tester',
      dependencies: devTaskNames,
    },
    {
      name: t('workteam.auto_89d9f5', {}, undefined),
      description:
        t('workteam.auto_cbcf20', {}, undefined),
      expected_output: t('workteam.auto_7f51a0', {}, undefined),
      agent_role: 'code_reviewer',
      dependencies: [t('workteam.auto_93289e', {}, undefined)],
    },
    {
      name: t('workteam.auto_4b6889', {}, undefined),
      description:
        t('workteam.auto_42f933', {}, undefined),
      expected_output: t('workteam.auto_d6a625', {}, undefined),
      agent_role: 'developer',
      dependencies: [t('workteam.auto_89d9f5', {}, undefined)],
    },
  );

  return { process_type: 'dag', agents, tasks };
}

export function getSdlcEvalConfigs(
  reviewRetries = 3,
  runnerProfile?: RunnerProfile,
): Record<string, string> {
  const clampedRetries = Math.min(Math.max(reviewRetries, 1), 5);
  const configs: Record<string, string> = {
    [t('workteam.auto_573b37', {}, undefined)]: JSON.stringify({
      approval: { required: true, prompt: t('workteam.auto_bb456b', {}, undefined) },
    }),
    [t('workteam.devTaskPrefix', {}, undefined)]: JSON.stringify({
      enabled: true,
      eval_max_retries: 2,
      criteria: t('workteam.auto_beb3cd', {}, undefined),
      required_patterns: ['worktree_acquire'],
    }),
    [t('workteam.auto_89d9f5', {}, undefined)]: JSON.stringify({
      enabled: true,
      eval_max_retries: clampedRetries,
      criteria:
        t('workteam.auto_6de07e', {}, undefined),
    }),
  };
  if (runnerProfile && runnerProfile.testSuccessPatterns.length > 0) {
    configs[t('workteam.auto_93289e', {}, undefined)] = JSON.stringify({
      enabled: true,
      eval_max_retries: 2,
      criteria: t('workteam.testCriteria', { command: runnerProfile.testCommand }, undefined),
      required_patterns: runnerProfile.testSuccessPatterns,
    });
  }
  return configs;
}

export async function createSdlcTeam(
  teamName: string,
  options: SdlcTemplateOptions = {},
): Promise<{
  team: WorkteamRecord;
  agents: WorkteamAgentRecord[];
  tasks: WorkteamTaskRecord[];
}> {
  const template = buildSdlcTemplate(options);
  const result = await createTeamFromSmartResult(template, teamName);

  const evalConfigs = getSdlcEvalConfigs(
    options.reviewRetries,
    options.runnerProfile,
  );
  for (const task of result.tasks) {
    const matchKey = Object.keys(evalConfigs).find(
      (k) => task.name === k || task.name.startsWith(`${k}:`),
    );
    if (matchKey) {
      await updateWorkteamTask(task.id, { eval_config: evalConfigs[matchKey] });
      task.eval_config = evalConfigs[matchKey];
    }
  }

  return result;
}
