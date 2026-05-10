import { describe, expect, it } from 'vitest';

import {
  REPO_REVIEW_AGENTIC_EXTRACTOR_TEMPLATE,
  REPO_REVIEW_AGENTIC_FINAL_TEMPLATE,
  REPO_REVIEW_AGENTIC_PLAN_TEMPLATE,
  REPO_REVIEW_AGENTIC_SUBAGENT_TEMPLATE,
  REPO_REVIEW_DIGEST_TEMPLATE,
  REPO_REVIEW_PRIMARY_TEMPLATE,
  REPO_REVIEW_REDUCER_TEMPLATE,
  REPO_REVIEW_SUPPLEMENTAL_FILE_TEMPLATE,
  REPO_REVIEW_PROMPT_TEMPLATES,
  REPO_REVIEW_WORKER_TEMPLATE,
} from './repo-review-prompt-templates.js';
import { buildReviewPrompt } from './repo-review-run-executor.js';
import { getPromptDefinition } from '../prompt/prompt-registry.js';
import { buildPromptPreviewFromRuntime } from '../prompt/prompt-preview-service.js';

describe('repo-review prompt templates (lean mode)', () => {
  it('repo-review prompt templates do not contain auto placeholders', () => {
    const templates = [
      REPO_REVIEW_PRIMARY_TEMPLATE,
      REPO_REVIEW_WORKER_TEMPLATE,
      REPO_REVIEW_REDUCER_TEMPLATE,
      REPO_REVIEW_AGENTIC_PLAN_TEMPLATE,
      REPO_REVIEW_AGENTIC_SUBAGENT_TEMPLATE,
      REPO_REVIEW_AGENTIC_FINAL_TEMPLATE,
      REPO_REVIEW_AGENTIC_EXTRACTOR_TEMPLATE,
      REPO_REVIEW_SUPPLEMENTAL_FILE_TEMPLATE,
      REPO_REVIEW_DIGEST_TEMPLATE,
    ].join('\n');
    expect(templates).not.toMatch(/auto_[0-9a-f]{6}/);
  });

  it('primary template carries diff evidence and project context inline', () => {
    expect(REPO_REVIEW_PRIMARY_TEMPLATE).toContain('{{diffText}}');
    expect(REPO_REVIEW_PRIMARY_TEMPLATE).toContain('{{projectContextBlock}}');
  });

  it('primary template only asks for structured JSON output', () => {
    expect(REPO_REVIEW_PRIMARY_TEMPLATE).toContain('只返回一个 JSON 对象');
    expect(REPO_REVIEW_PRIMARY_TEMPLATE).toContain('"overall": "pass | warn | fail | error | skipped"');
    expect(REPO_REVIEW_PRIMARY_TEMPLATE).not.toContain('代码审查报告');
    expect(REPO_REVIEW_PRIMARY_TEMPLATE).not.toContain('分支结论：<一句完整结论');
    expect(REPO_REVIEW_PRIMARY_TEMPLATE).not.toContain('真实代码片段');
    expect(REPO_REVIEW_PRIMARY_TEMPLATE).not.toContain('```<language>');
  });

  it('extractor template keeps the fixed report shape for formatting', () => {
    expect(REPO_REVIEW_AGENTIC_EXTRACTOR_TEMPLATE).toContain('## 代码审查报告');
    expect(REPO_REVIEW_AGENTIC_EXTRACTOR_TEMPLATE).toContain('### 一、审查总结');
    expect(REPO_REVIEW_AGENTIC_EXTRACTOR_TEMPLATE).toContain('**文件：** `文件路径:行号`');
    expect(REPO_REVIEW_AGENTIC_EXTRACTOR_TEMPLATE).toContain('// 修复后的代码');
    expect(REPO_REVIEW_AGENTIC_EXTRACTOR_TEMPLATE).toContain('| 风险等级 | 数量 | 主要问题 |');
    expect(REPO_REVIEW_AGENTIC_EXTRACTOR_TEMPLATE).toContain('markdown_body');
  });

  it('agentic subagent template now asks for markdown instead of json', () => {
    expect(REPO_REVIEW_AGENTIC_SUBAGENT_TEMPLATE).toContain('只输出一个 Markdown 报告');
    expect(REPO_REVIEW_AGENTIC_SUBAGENT_TEMPLATE).not.toContain('只返回一个 JSON 对象');
  });

  it('supplemental file template now asks for markdown instead of json', () => {
    expect(REPO_REVIEW_SUPPLEMENTAL_FILE_TEMPLATE).toContain('只输出一个 Markdown 报告');
    expect(REPO_REVIEW_SUPPLEMENTAL_FILE_TEMPLATE).not.toContain('只返回一个 JSON 对象');
  });

  it('supplemental file template carries inline file evidence', () => {
    expect(REPO_REVIEW_SUPPLEMENTAL_FILE_TEMPLATE).toContain('{{fileDiff}}');
    expect(REPO_REVIEW_SUPPLEMENTAL_FILE_TEMPLATE).toContain('{{fileContent}}');
  });

  it('reviewer templates include the agentic review stages', () => {
    const reviewerKeys: Array<keyof typeof REPO_REVIEW_PROMPT_TEMPLATES> = [
      'repo_review.primary',
      'repo_review.worker',
      'repo_review.reducer',
      'repo_review.agentic_plan',
      'repo_review.agentic_subagent',
      'repo_review.agentic_final',
      'repo_review.agentic_extractor',
      'repo_review.supplemental_file',
    ];
    for (const key of reviewerKeys) {
      const template = REPO_REVIEW_PROMPT_TEMPLATES[key];
      expect(template, `${key} should mention diff evidence`).toMatch(/diff/);
    }
  });

  it('every lean template stays under 8KB to keep provider input bounded', () => {
    for (const [key, template] of Object.entries(REPO_REVIEW_PROMPT_TEMPLATES)) {
      const bytes = Buffer.byteLength(template, 'utf8');
      expect(bytes, `${key} should be < 8KB, was ${bytes}`).toBeLessThan(8 * 1024);
    }
  });

  it('prompt-registry repo_review.* defaultTemplate stays in sync with templates file', () => {
    for (const [key, template] of Object.entries(REPO_REVIEW_PROMPT_TEMPLATES)) {
      const def = getPromptDefinition(key);
      expect(def, `registry should define ${key}`).toBeDefined();
      expect(def?.defaultTemplate).toBe(template);
    }
  });

  it('runtime primary prompt uses lean template instead of inline diff fallback', async () => {
    const prompt = await buildReviewPrompt({
      repository: { name: 'demo-repo', language: 'TypeScript' } as any,
      profile: { promptTemplate: '', includeFullFileContext: true } as any,
      event: { stage: 'push', source: 'local-hook' } as any,
      prepared: {
        actor: 'alice',
        branch: 'main',
        baseSha: 'base123',
        headSha: 'head456',
        commitSummaryLines: ['abc test commit'],
        changedFiles: ['src/demo.ts'],
        projectContextBlocks: ['TypeScript monorepo.'],
        diffText: 'diff --git a/src/demo.ts b/src/demo.ts\n+export const demo = true;',
      } as any,
    });

    expect(prompt).toContain('取证范围：base123..head456');
    expect(prompt).toContain('本次已开启“全文件补充审查”');
    expect(prompt).toContain('TypeScript monorepo.');
    expect(prompt).toContain('diff --git a/src/demo.ts b/src/demo.ts');
    expect(prompt).not.toContain('SHOULD_NOT_INLINE_DIFF');
  });

  it('runtime prompts use a valid fallback diff range when base is missing', async () => {
    const prompt = await buildReviewPrompt({
      repository: { name: 'demo-repo', language: 'TypeScript' } as any,
      profile: { promptTemplate: '', includeFullFileContext: false } as any,
      event: { stage: 'push', source: 'local-hook' } as any,
      prepared: {
        actor: 'alice',
        branch: 'main',
        baseSha: '',
        headSha: 'head789',
        commitSummaryLines: [],
        changedFiles: ['src/demo.ts'],
        projectContextBlocks: [],
        diffText: 'diff --git a/src/demo.ts b/src/demo.ts\n+export const demo = true;',
      } as any,
    });

    expect(prompt).toContain('基线提交：(none)');
    expect(prompt).toContain('目标提交：head789');
    expect(prompt).toContain('取证范围：head789^!');
    expect(prompt).toContain('diff --git a/src/demo.ts b/src/demo.ts');
  });

  it('injects the custom review prompt exactly once per rendered prompt', async () => {
    const prompt = await buildReviewPrompt({
      repository: { name: 'demo-repo', language: 'TypeScript' } as any,
      profile: {
        promptTemplate: '附加审查要求：\nSTRICT REVIEW POLICY',
        includeFullFileContext: false,
      } as any,
      event: { stage: 'push', source: 'local-hook' } as any,
      prepared: {
        actor: 'alice',
        branch: 'main',
        baseSha: 'base123',
        headSha: 'head456',
        commitSummaryLines: [],
        changedFiles: ['src/demo.ts'],
        projectContextBlocks: [],
        diffText: 'diff --git a/src/demo.ts b/src/demo.ts\n+export const demo = true;',
      } as any,
    });

    expect(prompt.match(/附加审查要求：/g)).toHaveLength(1);
    expect(prompt.match(/STRICT REVIEW POLICY/g)).toHaveLength(1);
  });

  it('runtime digest prompt includes stable repo, window, branch and commit metadata', async () => {
    const prompt = await buildPromptPreviewFromRuntime({
      promptKey: 'repo_review.digest',
      variables: {
        data: {
          repositoryName: 'demo-repo',
          periodStart: '2026-04-28T00:00:00.000Z',
          periodEnd: '2026-04-29T00:00:00.000Z',
          type: 'daily',
          branches: [
            {
              name: 'main',
              commitCount: 2,
              contributors: ['alice'],
              commitsByCategory: {
                feature: 1,
                fix: 1,
                refactor: 0,
                perf: 0,
                docs: 0,
                test: 0,
                chore: 0,
                other: 0,
              },
              commitMessages: ['feat: add digest source', 'fix: tidy digest prompt'],
            },
          ],
          totalCommits: 2,
          totalContributors: ['alice'],
          sampledCommits: [],
          categorySummary: {
            feature: 1,
            fix: 1,
            refactor: 0,
            perf: 0,
            docs: 0,
            test: 0,
            chore: 0,
            other: 0,
          },
          defaultBranch: 'main',
        },
      },
    });

    expect(prompt?.userPromptText).toContain('demo-repo');
    expect(prompt?.userPromptText).toContain('2026-04-28');
    expect(prompt?.userPromptText).toContain('2026-04-29');
    expect(prompt?.userPromptText).toContain('main');
    expect(prompt?.userPromptText).toContain('2');
    expect(prompt?.userPromptText).not.toMatch(/auto_[0-9a-f]{6}/);
  });

  it('repo-review runtime preview returns prompt resolution metadata', async () => {
    const preview = await buildPromptPreviewFromRuntime({
      promptKey: 'repo_review.primary',
      variables: {
        repository: { name: 'demo-repo', language: 'TypeScript' },
        profile: { promptTemplate: '', includeFullFileContext: false },
        event: { stage: 'push', source: 'local-hook' },
        prepared: {
          actor: 'alice',
          branch: 'main',
          baseSha: 'base123',
          headSha: 'head456',
          commitSummaryLines: [],
          changedFiles: ['src/demo.ts'],
          projectContextBlocks: [],
          diffText: 'SHOULD_NOT_INLINE_DIFF',
        },
      },
    });

    expect(preview?.resolution).toHaveLength(1);
    expect(preview?.resolution[0]?.promptKey).toBe('repo_review.primary');
    expect(preview?.segments[0]?.source).toBe(preview?.resolution[0]?.source);
  });

  it('agentic plan prompt keeps the raw diff out of the rendered body', async () => {
    const prompt = await buildPromptPreviewFromRuntime({
      promptKey: 'repo_review.agentic_plan',
      variables: {
        repository: { name: 'demo-repo', language: 'TypeScript' },
        profile: {
          promptTemplate: '',
          includeFullFileContext: false,
          diffSubagentThreshold: 15,
          reviewOutputMode: 'message',
        },
        event: { stage: 'push', source: 'local-hook', actor: 'alice' },
        prepared: {
          actor: 'alice',
          branch: 'main',
          baseSha: 'base123',
          headSha: 'head456',
          commitSummaryLines: ['abc test commit'],
          changedFiles: ['src/demo.ts'],
          diffText: 'SHOULD_NOT_INLINE_DIFF',
        },
      },
    });

    expect(prompt?.userPromptText).toContain('主审查代理职责');
    expect(prompt?.userPromptText).not.toContain('SHOULD_NOT_INLINE_DIFF');
  });
});
