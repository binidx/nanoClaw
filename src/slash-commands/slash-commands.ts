import {
  buildSlashCommandHelpText,
  parseSlashCommand,
  type ParsedSlashCommand,
} from './slash-commands-parser.js';
import {
  createSlashCommandHandlers,
  type SlashCommandExecutionResult,
  type SlashCommandExecutorOptions,
} from './slash-commands-handlers.js';
import { t } from '../i18n/index.js';

export type {
  ParsedCommandOptions,
  ParsedSlashCommand,
} from './slash-commands-parser.js';
export {
  buildSlashCommandHelpText,
  getOptionValue,
  getOptionValues,
  isOptionEnabled,
  parseCommandOptions,
  parseEnvOption,
  parseSlashCommand,
  tokenizeCommandLine,
} from './slash-commands-parser.js';

export type {
  SlashCommandExecutionResult,
  SlashCommandExecutorOptions,
} from './slash-commands-handlers.js';

export function createSlashCommandExecutor(opts: SlashCommandExecutorOptions) {
  const handlers = createSlashCommandHandlers(opts);

  const executeSlashCommand = async (input: {
    jid: string;
    rawText: string;
    refreshTaskSnapshots?: () => void;
  }): Promise<SlashCommandExecutionResult> => {
    const normalizedRawText = input.rawText.trim();
    if (!normalizedRawText.startsWith('/')) {
      return { handled: false, success: true, output: '' };
    }

    let parsed: ParsedSlashCommand | null = null;
    try {
      parsed = parseSlashCommand(normalizedRawText);
    } catch (err) {
      return {
        handled: true,
        success: false,
        output: err instanceof Error ? err.message : t('slashCommands.auto_4e523c', {}, undefined),
      };
    }

    if (!parsed) {
      return {
        handled: true,
        success: false,
        output: t(
          'slashCommands.unknownCommand',
          {
            command: normalizedRawText,
            help: buildSlashCommandHelpText(),
          },
          undefined,
        ),
      };
    }

    try {
      switch (parsed.command) {
        case 'help':
        case 'commands':
          return {
            handled: true,
            success: true,
            output: buildSlashCommandHelpText(),
          };
        case 'skills':
        case 'skill':
          return handlers.executeSkillsCommand(parsed.args);
        case 'skill-create':
          return handlers.executeSkillsCommand(['create', ...parsed.args]);
        case 'mcp-install':
          return handlers.executeMcpInstallCommand(parsed.args);
        case 'mcp-list':
          return handlers.executeMcpCommand(['list']);
        case 'mcp':
          return handlers.executeMcpCommand(parsed.args);
        case 'task-create':
        case 'task-new':
          return handlers.executeTaskCommand(
            input.jid,
            'task-create',
            parsed.args,
            input.refreshTaskSnapshots,
          );
        case 'tasks':
          return {
            handled: true,
            success: true,
            output: await handlers.formatConversationTasksList(input.jid),
          };
        case 'task-draft':
          return handlers.executeTaskCommand(
            input.jid,
            'task-draft',
            parsed.args,
            input.refreshTaskSnapshots,
          );
        default:
          return {
            handled: true,
            success: false,
            output: t(
              'slashCommands.unknownCommand',
              {
                command: `/${parsed.command}`,
                help: buildSlashCommandHelpText(),
              },
              undefined,
            ),
          };
      }
    } catch (err) {
      return {
        handled: true,
        success: false,
        output:
          err instanceof Error
            ? t('slashCommands.commandFailed', { message: err.message }, undefined)
            : t('errors.auto_7b0b90', {}, undefined),
      };
    }
  };

  return {
    executeSlashCommand,
    formatSlashCommandResultOutput: handlers.formatSlashCommandResultOutput,
    persistWebCommandAssistantMessage: handlers.persistWebCommandAssistantMessage,
    persistWebCommandInboundMessage: handlers.persistWebCommandInboundMessage,
  };
}
