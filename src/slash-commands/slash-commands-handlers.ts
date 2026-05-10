import path from 'path';

import { getAssistantName } from '../config-store.js';
import {
  createTask,
  getConfig,
  getRegisteredGroup,
  getTasksForChat,
  setConfig,
  storeChatMetadata,
  storeMessageDirect,
} from '../db.js';
import { logger } from '../logger.js';
import { getWebChannel } from '../channels/web.js';
import {
  CUSTOM_SKILLS_ROOT,
  deleteCustomSkill,
  listManagedSkills,
  parseEnabledSkillsConfig,
  serializeEnabledSkillsConfig,
  WEB_ENABLED_SKILLS_CONFIG_KEY,
} from '../runtime/runtime-customization.js';
import { computeInitialNextRun } from '../scheduler/task-schedule.js';
import {
  buildSlashCommandHelpText,
  getOptionValue,
  getOptionValues,
  isOptionEnabled,
  parseCommandOptions,
  parseEnvOption,
} from './slash-commands-parser.js';
import { t } from '../i18n/index.js';

export interface SlashCommandExecutionResult {
  handled: boolean;
  success: boolean;
  output: string;
}

export interface SlashCommandExecutorOptions {
  refreshTaskSnapshots?: () => void;
  getManagedSkillsForResponse: () =>
    | Array<{
        id: string;
        enabled: boolean;
        source: string;
        description?: string;
      }>
    | Promise<
        Array<{
          id: string;
          enabled: boolean;
          source: string;
          description?: string;
        }>
      >;
  getManagedMcpServersForResponse: () =>
    | Array<{
        id: string;
        enabled: boolean;
        name?: string;
        command: string;
        args: string[];
        env?: Record<string, string>;
      }>
    | Promise<
        Array<{
          id: string;
          enabled: boolean;
          name?: string;
          command: string;
          args: string[];
          env?: Record<string, string>;
        }>
      >;
  persistManagedMcpServers: (
    servers: Array<{
      id: string;
      enabled: boolean;
      name?: string;
      command: string;
      args: string[];
      env?: Record<string, string>;
    }>,
  ) => void | Promise<void>;
  installManagedMcpServerFromInput: (input: {
    sourcePath: string;
    id?: string;
    name?: string;
    entryFile?: string;
    overwrite?: boolean;
    enabled?: boolean;
    env?: Record<string, string>;
  }) =>
    | Promise<{
        installed: {
          id: string;
          entryPath: string;
        };
      }>
    | {
        installed: {
          id: string;
          entryPath: string;
        };
      };
  installCustomSkillFromPath: (input: {
    sourcePath: string;
    skillId?: string;
    overwrite?: boolean;
  }) => string;
  createSkillWithAiFromInput: (input: {
    request: string;
    skillId?: string;
    name?: string;
    overwrite?: boolean;
  }) => Promise<{
    created: {
      id: string;
      path: string;
      extraFiles: string[];
    };
  }>;
  deriveTaskTitle: (title: unknown, prompt: unknown) => string;
  generateAiTaskDraft: (request: string) => Promise<{
    title: string;
    prompt: string;
    scheduleType: 'cron' | 'interval' | 'once';
    scheduleValue: string;
    contextMode: 'group' | 'isolated';
    summary: string;
  }>;
}

export function createSlashCommandHandlers(opts: SlashCommandExecutorOptions) {
  const formatManagedSkillsList = async () => {
    const skills = await Promise.resolve(opts.getManagedSkillsForResponse());
    if (skills.length === 0) {
      return t('slashCommands.auto_f52e78', {}, undefined);
    }
    return [
      `Skills (${skills.length})`,
      t('slashCommands.customDir', { path: CUSTOM_SKILLS_ROOT }, undefined),
      ...skills.map(
        (skill) =>
          `- ${skill.id} [${skill.enabled ? 'enabled' : 'disabled'}] (${skill.source})${skill.description ? `: ${skill.description}` : ''}`,
      ),
    ].join('\n');
  };

  const formatManagedMcpList = async () => {
    const servers = await Promise.resolve(opts.getManagedMcpServersForResponse());
    if (servers.length === 0) {
      return t('slashCommands.auto_3c6497', {}, undefined);
    }
    return [
      `MCP Servers (${servers.length})`,
      ...servers.map((server) => {
        const argsText =
          server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
        return `- ${server.id} [${server.enabled ? 'enabled' : 'disabled'}] => ${server.command}${argsText}`;
      }),
    ].join('\n');
  };

  const enableInstalledSkillIfNeeded = async (skillId: string) => {
    try {
      const currentEnabled = parseEnabledSkillsConfig(
        await getConfig(WEB_ENABLED_SKILLS_CONFIG_KEY),
      );
      if (currentEnabled) {
        currentEnabled.add(skillId);
        await setConfig(
          WEB_ENABLED_SKILLS_CONFIG_KEY,
          serializeEnabledSkillsConfig(currentEnabled),
        );
      }
    } catch (err) {
      logger.warn({ err, skillId }, 'Failed to auto-enable installed skill');
    }
  };

  const updateSkillEnabledState = async (skillId: string, nextEnabled: boolean) => {
    const allSkills = listManagedSkills(process.cwd());
    if (!allSkills.some((skill) => skill.id === skillId)) {
      throw new Error(`Unknown skill id: ${skillId}`);
    }

    let enabled = parseEnabledSkillsConfig(
      await getConfig(WEB_ENABLED_SKILLS_CONFIG_KEY),
    );
    if (!enabled) {
      enabled = new Set(allSkills.map((skill) => skill.id));
    }

    if (nextEnabled) {
      enabled.add(skillId);
    } else {
      enabled.delete(skillId);
    }

    await setConfig(
      WEB_ENABLED_SKILLS_CONFIG_KEY,
      serializeEnabledSkillsConfig(enabled),
    );
  };

  const updateMcpEnabledState = async (mcpId: string, nextEnabled: boolean) => {
    const servers = await Promise.resolve(opts.getManagedMcpServersForResponse());
    const next = servers.map((server) =>
      server.id === mcpId ? { ...server, enabled: nextEnabled } : server,
    );
    if (!next.some((server) => server.id === mcpId)) {
      throw new Error(`Unknown MCP id: ${mcpId}`);
    }
    await Promise.resolve(opts.persistManagedMcpServers(next));
  };

  const removeManagedMcpServer = async (mcpId: string) => {
    const servers = await Promise.resolve(opts.getManagedMcpServersForResponse());
    const next = servers.filter((server) => server.id !== mcpId);
    if (next.length === servers.length) {
      throw new Error(`Unknown MCP id: ${mcpId}`);
    }
    await Promise.resolve(opts.persistManagedMcpServers(next));
  };

  const persistWebCommandInboundMessage = async (
    jid: string,
    senderName: string,
    rawContent: string,
  ): Promise<{ id: string; timestamp: string; }> => {
    const timestamp = new Date().toISOString();
    const id = `webcmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const content = rawContent.trim();
    await storeChatMetadata(jid, timestamp);
    await storeMessageDirect({
      id,
      chat_jid: jid,
      sender: 'web_command',
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });

    const webChannel = getWebChannel();
    if (webChannel) {
      webChannel.notifyMessage(jid, {
        id,
        content,
        sender: 'web_user',
        sender_name: senderName,
        timestamp,
        is_bot: false,
        is_from_me: true,
      });
    }
    return { id, timestamp };
  };

  const formatSlashCommandResultOutput = (
    result: SlashCommandExecutionResult,
    extras?: { uploadsIgnored?: boolean },
  ): string => {
    const title = result.success ? t('slashCommands.auto_83b892', {}, undefined) : t('slashCommands.auto_f8d339', {}, undefined);
    const lines = [title, '', result.output.trim() || t('slashCommands.auto_26d45b', {}, undefined)];
    if (extras?.uploadsIgnored) {
      lines.push('', t('slashCommands.auto_76dac5', {}, undefined));
    }
    return lines.join('\n').trim();
  };

  const persistWebCommandAssistantMessage = async (
    jid: string,
    text: string,
  ): Promise<{ id: string; timestamp: string; }> => {
    const timestamp = new Date().toISOString();
    const id = `webcmd_result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const content = text.trim() || t('slashCommands.auto_b1a23e', {}, undefined);
    await storeChatMetadata(jid, timestamp);
    await storeMessageDirect({
      id,
      chat_jid: jid,
      sender: await getAssistantName(),
      sender_name: await getAssistantName(),
      content,
      timestamp,
      is_from_me: true,
      is_bot_message: true,
    });

    const webChannel = getWebChannel();
    if (webChannel) {
      webChannel.notifyMessage(jid, {
        id,
        content,
        sender: await getAssistantName(),
        sender_name: await getAssistantName(),
        timestamp,
        is_bot: true,
        is_from_me: true,
      });
    }
    return { id, timestamp };
  };

  const executeSkillsCommand = async (
    args: string[],
  ): Promise<SlashCommandExecutionResult> => {
    if (args.length === 0 || /^(list|ls)$/i.test(args[0]!)) {
      return {
        handled: true,
        success: true,
        output: await formatManagedSkillsList(),
      };
    }

    const sub = args[0]!.toLowerCase();
    const rest = args.slice(1);
    const options = parseCommandOptions(rest);

    if (sub === 'install') {
      const sourcePath =
        options.positional[0] || getOptionValue(options, 'path');
      if (!sourcePath) {
        return {
          handled: true,
          success: false,
          output:
            t('slashCommands.auto_1daba5', {}, undefined),
        };
      }

      const installedSkillId = opts.installCustomSkillFromPath({
        sourcePath,
        skillId: getOptionValue(options, 'id') || '',
        overwrite: isOptionEnabled(options, 'overwrite'),
      });
      await enableInstalledSkillIfNeeded(installedSkillId);
      return {
        handled: true,
        success: true,
        output: [
          t('slashCommands.skillInstallSuccess', { id: installedSkillId }, undefined),
          t('slashCommands.pathLabel', { path: path.join(CUSTOM_SKILLS_ROOT, installedSkillId) }, undefined),
        ].join('\n'),
      };
    }

    if (sub === 'create') {
      const request =
        options.positional.join(' ').trim() ||
        getOptionValue(options, 'request') ||
        '';
      if (!request.trim()) {
        return {
          handled: true,
          success: false,
          output:
            t('slashCommands.auto_7beefc', {}, undefined),
        };
      }

      const created = await opts.createSkillWithAiFromInput({
        request,
        skillId: getOptionValue(options, 'id') || '',
        name: getOptionValue(options, 'name') || '',
        overwrite: isOptionEnabled(options, 'overwrite'),
      });
      return {
        handled: true,
        success: true,
        output: [
          t('slashCommands.skillCreateSuccess', { id: created.created.id }, undefined),
          t('slashCommands.pathLabel', { path: created.created.path }, undefined),
          created.created.extraFiles.length > 0
            ? t('slashCommands.extraFiles', { files: created.created.extraFiles.join(', ') }, undefined)
            : t('slashCommands.auto_69b326', {}, undefined),
        ].join('\n'),
      };
    }

    if (sub === 'enable' || sub === 'disable') {
      const skillId = options.positional[0];
      if (!skillId) {
        return {
          handled: true,
          success: false,
          output: t('slashCommands.missingSkillId', { sub }, undefined),
        };
      }
      await updateSkillEnabledState(skillId, sub === 'enable');
      return {
        handled: true,
        success: true,
        output: t('slashCommands.skillToggled', { id: skillId, action: t(sub === 'enable' ? 'slashCommands.enabled' : 'slashCommands.disabled', {}, undefined) }, undefined),
      };
    }

    if (sub === 'delete' || sub === 'remove') {
      const skillId = options.positional[0];
      if (!skillId) {
        return {
          handled: true,
          success: false,
          output: t('slashCommands.missingSkillId', { sub }, undefined),
        };
      }
      deleteCustomSkill(skillId);
      try {
        const currentEnabled = parseEnabledSkillsConfig(
          await getConfig(WEB_ENABLED_SKILLS_CONFIG_KEY),
        );
        if (currentEnabled) {
          currentEnabled.delete(skillId);
          await setConfig(
            WEB_ENABLED_SKILLS_CONFIG_KEY,
            serializeEnabledSkillsConfig(currentEnabled),
          );
        }
      } catch (err) {
        logger.warn(
          { err, skillId },
          'Failed to update enabled skills after command delete',
        );
      }
      return {
        handled: true,
        success: true,
        output: t('slashCommands.skillDeleted', { id: skillId }, undefined),
      };
    }

    return {
      handled: true,
      success: false,
      output: t('slashCommands.unknownSubcommand', { sub, help: buildSlashCommandHelpText() }, undefined),
    };
  };

  const executeMcpInstallCommand = async (
    args: string[],
  ): Promise<SlashCommandExecutionResult> => {
    const options = parseCommandOptions(args);
    const sourcePath = options.positional[0] || getOptionValue(options, 'path');
    if (!sourcePath) {
      return {
        handled: true,
        success: false,
        output:
          t('slashCommands.auto_4104c2', {}, undefined),
      };
    }

    const result = await Promise.resolve(
      opts.installManagedMcpServerFromInput({
        sourcePath,
        id: getOptionValue(options, 'id') || '',
        name: getOptionValue(options, 'name') || '',
        entryFile:
          getOptionValue(options, 'entry') ||
          getOptionValue(options, 'entryfile') ||
          '',
        overwrite: isOptionEnabled(options, 'overwrite'),
        enabled: !isOptionEnabled(options, 'disabled'),
        env: parseEnvOption(getOptionValues(options, 'env')),
      }),
    );

    return {
      handled: true,
      success: true,
      output: [
        t('slashCommands.mcpInstallSuccess', { id: result.installed.id }, undefined),
        t('slashCommands.mcpEntry', { path: result.installed.entryPath }, undefined),
        t('slashCommands.auto_574d92', {}, undefined),
      ].join('\n'),
    };
  };

  const executeMcpCommand = async (
    args: string[],
  ): Promise<SlashCommandExecutionResult> => {
    if (args.length === 0 || /^(list|ls)$/i.test(args[0]!)) {
      return {
        handled: true,
        success: true,
        output: await formatManagedMcpList(),
      };
    }

    const sub = args[0]!.toLowerCase();
    const rest = args.slice(1);
    const options = parseCommandOptions(rest);

    if (sub === 'install') {
      return executeMcpInstallCommand(rest);
    }

    if (sub === 'enable' || sub === 'disable') {
      const mcpId = options.positional[0];
      if (!mcpId) {
        return {
          handled: true,
          success: false,
          output: t('slashCommands.missingMcpId', { sub }, undefined),
        };
      }
      await updateMcpEnabledState(mcpId, sub === 'enable');
      return {
        handled: true,
        success: true,
        output: t('slashCommands.mcpToggled', { id: mcpId, action: t(sub === 'enable' ? 'slashCommands.enabled' : 'slashCommands.disabled', {}, undefined) }, undefined),
      };
    }

    if (sub === 'remove' || sub === 'delete') {
      const mcpId = options.positional[0];
      if (!mcpId) {
        return {
          handled: true,
          success: false,
          output: t('slashCommands.missingMcpId', { sub }, undefined),
        };
      }
      await removeManagedMcpServer(mcpId);
      return {
        handled: true,
        success: true,
        output: t('slashCommands.mcpRemoved', { id: mcpId }, undefined),
      };
    }

    return {
      handled: true,
      success: false,
      output: t('slashCommands.unknownMcpSubcommand', { sub, help: buildSlashCommandHelpText() }, undefined),
    };
  };

  const formatConversationTasksList = async (jid: string): Promise<string> => {
    const tasks = await getTasksForChat(jid);
    if (tasks.length === 0) {
      return t('slashCommands.auto_1fbcb6', {}, undefined);
    }
    return [
      t('slashCommands.taskList', { count: tasks.length }, undefined),
      ...tasks.map((task) => {
        const title =
          task.title || opts.deriveTaskTitle(task.title, task.prompt);
        return `- ${task.id} [${task.status}] ${title} | ${task.schedule_type} ${task.schedule_value} | next: ${task.next_run}`;
      }),
    ].join('\n');
  };

  const executeTaskCommand = async (
    jid: string,
    command: 'task-create' | 'task-draft',
    args: string[],
    refreshTaskSnapshots?: () => void,
  ): Promise<SlashCommandExecutionResult> => {
    const options = parseCommandOptions(args);
    const request =
      options.positional.join(' ').trim() ||
      getOptionValue(options, 'request') ||
      '';
    if (!request.trim()) {
      return {
        handled: true,
        success: false,
        output: t('slashCommands.missingTaskReq', { command }, undefined),
      };
    }

    const draft = await opts.generateAiTaskDraft(request);
    if (command === 'task-draft') {
      return {
        handled: true,
        success: true,
        output: [
          t('slashCommands.auto_50ddae', {}, undefined),
          t('slashCommands.taskDraftTitle', { title: draft.title }, undefined),
          t('slashCommands.taskDraftPrompt', { prompt: draft.prompt }, undefined),
          t('slashCommands.taskDraftSchedule', { type: draft.scheduleType, value: draft.scheduleValue }, undefined),
          t('slashCommands.taskDraftContext', { mode: draft.contextMode }, undefined),
          draft.summary ? t('slashCommands.taskDraftAiNote', { summary: draft.summary }, undefined) : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }

    const group = await getRegisteredGroup(jid);
    if (!group) {
      return {
        handled: true,
        success: false,
        output: t('slashCommands.auto_049c50', {}, undefined),
      };
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nextRun = computeInitialNextRun(
      draft.scheduleType,
      draft.scheduleValue,
    );
    await createTask({
      id: taskId,
      title: opts.deriveTaskTitle(draft.title, draft.prompt),
      group_folder: group.folder,
      chat_jid: jid,
      prompt: draft.prompt,
      schedule_type: draft.scheduleType,
      schedule_value: draft.scheduleValue,
      context_mode: draft.contextMode,
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    refreshTaskSnapshots?.();

    return {
      handled: true,
      success: true,
      output: [
        t('slashCommands.taskCreateSuccess', { id: taskId }, undefined),
        t('slashCommands.taskDraftTitle', { title: draft.title }, undefined),
        t('slashCommands.taskDraftSchedule', { type: draft.scheduleType, value: draft.scheduleValue }, undefined),
        t('slashCommands.taskNextRun', { time: nextRun }, undefined),
        t('slashCommands.taskDraftPrompt', { prompt: draft.prompt }, undefined),
        draft.summary ? t('slashCommands.taskDraftAiNote', { summary: draft.summary }, undefined) : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  };

  return {
    executeSkillsCommand,
    executeMcpInstallCommand,
    executeMcpCommand,
    formatConversationTasksList,
    executeTaskCommand,
    persistWebCommandInboundMessage,
    formatSlashCommandResultOutput,
    persistWebCommandAssistantMessage,
  };
}

