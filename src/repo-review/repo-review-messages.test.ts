import { describe, expect, it } from 'vitest';

import {
  buildStructuredRepoReviewMarkdown,
  formatRepoReviewCompletedMessage,
} from './repo-review-messages.js';

describe('repo-review messages', () => {
  it('renders structured markdown with scope metadata and code snippets', () => {
    const markdown = buildStructuredRepoReviewMarkdown(
      {
        summary: '分支结论：本次改动存在中风险问题，建议修复后再合并。',
        findings: [
          {
            severity: 'medium',
            file: 'src/repo-review/repo-review-coordinator.ts',
            line: '123-141',
            title: 'Reducer 结果被短摘要覆盖',
            detail: '最终 markdown_body 直接使用模型短摘要，导致开发者看不到完整问题分析。',
            codeSnippet: 'markdown_body: parsed.markdownBody || null,',
            fixCode: 'markdown_body: finalMarkdownBody,',
            suggestion: '统一使用本地固定模板渲染最终报告。',
          },
        ],
        commitReviews: [],
        suggestions: ['统一使用本地固定模板渲染最终报告。'],
      },
      {
        repositoryName: 'nanoclaw',
        branch: 'main',
        baseSha: '1234567890abcdef',
        headSha: 'fedcba0987654321',
        actor: 'alice',
        stage: 'push',
        scopeLimitations: ['未覆盖远端 provider 联调。'],
      },
    );

    expect(markdown).toContain('**审查范围：** 仓库 `nanoclaw` | 分支 `main` | 范围 `1234567890ab..fedcba098765`');
    expect(markdown).toContain('**文件：** `src/repo-review/repo-review-coordinator.ts:123-141`');
    expect(markdown).toContain('```ts');
    expect(markdown).toContain('markdown_body: parsed.markdownBody || null,');
    expect(markdown).toContain('markdown_body: finalMarkdownBody,');
    expect(markdown).toContain('**证据边界：**');
  });

  it('includes branch and scope in completed messages', () => {
    const message = formatRepoReviewCompletedMessage(
      {
        id: 'repo-1',
        name: 'nanoclaw',
      } as any,
      {
        stage: 'push',
        branch: 'main',
        baseSha: '1234567890abcdef',
        headSha: 'fedcba0987654321',
        prMrNumber: '',
        actor: 'alice',
        status: 'completed',
        overall: 'warn',
        summary: '存在风险',
        findings: [],
        commitDetails: [],
        commitReviews: [],
        suggestions: [],
        scopeLimitations: [],
        changedFiles: ['src/repo-review/repo-review-coordinator.ts'],
        markdownBody: '## 代码审查报告',
        rawModelOutput: '',
        recommendedBlock: false,
        blockingEnforced: false,
      } as any,
      'ai',
    );

    expect(message).toContain('审查范围: main | 1234567890ab..fedcba098765');
  });
});
