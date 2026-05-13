import { describe, expect, it } from 'vitest';

import {
  buildAssistantInstructionBlock,
  buildClaudePromptAppend,
  buildCodexResponsesInstructions,
} from './system-prompts.js';

describe('runner system prompts', () => {
  it('keeps soul instructions ahead of generic Claude guidance in append mode', () => {
    const prompt = buildClaudePromptAppend({
      globalClaudeMd: 'GLOBAL',
      defaultClaudeWebGuidance: 'DEFAULT',
      workspaceExtraGuidance: 'WORKSPACE',
      assistantInstructionBlock: 'ASSISTANT',
      assistantRuleMode: 'append',
      soulSystemPrompt: 'SOUL',
    });

    expect(prompt.indexOf('SOUL')).toBeLessThan(prompt.indexOf('GLOBAL'));
    expect(prompt.indexOf('SOUL')).toBeLessThan(prompt.indexOf('DEFAULT'));
    expect(prompt.indexOf('ASSISTANT')).toBeGreaterThan(prompt.indexOf('WORKSPACE'));
  });

  it('keeps locked assistant policy ahead of soul in Claude locked mode', () => {
    const assistantInstructionBlock = buildAssistantInstructionBlock({
      assistantInstructionsAppend: 'ASSISTANT',
      assistantRuleMode: 'locked',
    });
    const prompt = buildClaudePromptAppend({
      globalClaudeMd: 'GLOBAL',
      defaultClaudeWebGuidance: 'DEFAULT',
      workspaceExtraGuidance: 'WORKSPACE',
      assistantInstructionBlock,
      assistantRuleMode: 'locked',
      soulSystemPrompt: 'SOUL',
    });

    expect(prompt.indexOf('ASSISTANT')).toBeLessThan(prompt.indexOf('SOUL'));
    expect(prompt).not.toContain('GLOBAL');
    expect(prompt).not.toContain('DEFAULT');
  });

  it('puts soul instructions ahead of generic Codex coding guidance', () => {
    const prompt = buildCodexResponsesInstructions({
      projectDir: '/workspace/project',
      memoryGuidance: 'MEMORY',
      managedSkillsGuidance: 'SKILLS',
      subagentPolicyPrompt: 'SUBAGENTS',
      workspaceExtraGuidance: 'WORKSPACE',
      assistantInstructionBlock: 'ASSISTANT',
      assistantRuleMode: 'append',
      soulSystemPrompt: 'SOUL',
    });

    expect(prompt.indexOf('SOUL')).toBeLessThan(
      prompt.indexOf('You are a helpful coding assistant with access to tools.'),
    );
    expect(prompt).toContain('ASSISTANT');
  });

  it('keeps locked assistant policy ahead of soul in Codex instructions', () => {
    const prompt = buildCodexResponsesInstructions({
      projectDir: '/workspace/project',
      memoryGuidance: 'MEMORY',
      managedSkillsGuidance: 'SKILLS',
      subagentPolicyPrompt: 'SUBAGENTS',
      workspaceExtraGuidance: 'WORKSPACE',
      assistantInstructionBlock: 'ASSISTANT',
      assistantRuleMode: 'locked',
      soulSystemPrompt: 'SOUL',
    });

    expect(prompt.indexOf('ASSISTANT')).toBeLessThan(prompt.indexOf('SOUL'));
    expect(prompt.indexOf('SOUL')).toBeLessThan(
      prompt.indexOf('You are a helpful coding assistant with access to tools.'),
    );
  });

  it('uses lightweight scheduled task instructions for Codex when requested', () => {
    const prompt = buildCodexResponsesInstructions({
      projectDir: '/workspace/project',
      memoryGuidance: 'MEMORY',
      managedSkillsGuidance: 'SKILLS',
      subagentPolicyPrompt: 'SUBAGENTS',
      workspaceExtraGuidance: 'WORKSPACE',
      assistantInstructionBlock: 'ASSISTANT',
      assistantRuleMode: 'append',
      soulSystemPrompt: 'SOUL',
      lightweightTaskMode: true,
    });

    expect(prompt).toContain('You are executing a scheduled assistant task for the user.');
    expect(prompt).toContain('MEMORY');
    expect(prompt).toContain('ASSISTANT');
    expect(prompt).not.toContain('You are a helpful coding assistant with access to tools.');
    expect(prompt).not.toContain('SKILLS');
    expect(prompt).not.toContain('SUBAGENTS');
    expect(prompt).not.toContain('web_search');
  });

  it('uses lightweight scheduled task instructions for Claude when requested', () => {
    const prompt = buildClaudePromptAppend({
      globalClaudeMd: 'GLOBAL',
      defaultClaudeWebGuidance: 'DEFAULT',
      workspaceExtraGuidance: 'WORKSPACE',
      assistantInstructionBlock: 'ASSISTANT',
      assistantRuleMode: 'append',
      soulSystemPrompt: 'SOUL',
      lightweightTaskMode: true,
    });

    expect(prompt).toContain('You are executing a scheduled assistant task for the user.');
    expect(prompt).toContain('ASSISTANT');
    expect(prompt).toContain('SOUL');
    expect(prompt).not.toContain('GLOBAL');
    expect(prompt).not.toContain('DEFAULT');
  });
});
