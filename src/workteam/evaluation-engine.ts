import { createModuleLogger } from '../logger.js';
import {
  buildDirectProviderPromptEnvelope,
  resolvePromptText,
} from '../prompt/prompt-service.js';
import { generateTextWithDefaultProvider } from '../provider/provider-api.js';

const logger = createModuleLogger('workteam');

const EVAL_TEMPERATURE = 0.3;

export interface EvalConfig {
  enabled: boolean;
  eval_max_retries?: number;
  criteria?: string;
  required_patterns?: string[];
}

export interface EvalResult {
  pass: boolean;
  feedback: string;
  score?: number;
}

export function parseEvalConfig(raw: string): EvalConfig | null {
  if (!raw?.trim()) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const obj = v as Record<string, unknown>;
    if (obj.enabled !== true) return null;
    return {
      enabled: true,
      eval_max_retries: Number.isFinite(obj.eval_max_retries) ? Math.max(1, Math.min(obj.eval_max_retries as number, 5)) : 2,
      criteria: typeof obj.criteria === 'string' ? obj.criteria : undefined,
      required_patterns: Array.isArray(obj.required_patterns)
        ? (obj.required_patterns as unknown[]).filter((p): p is string => typeof p === 'string')
        : undefined,
    };
  } catch {
    return null;
  }
}

export function buildEvalPrompt(
  taskName: string,
  taskDescription: string,
  expectedOutput: string,
  actualOutput: string,
  criteria?: string,
): string {
  return `You are a strict quality evaluator for an AI agent task.

## Task
Name: ${taskName}
Description: ${taskDescription}

## Expected Output
${expectedOutput || '(not specified)'}

${criteria ? `## Evaluation Criteria\n${criteria}\n` : ''}
## Actual Output
${actualOutput}

## Instructions
Evaluate the actual output against the task description and expected output.
Reply with ONLY valid JSON matching this shape:
{
  "pass": true | false,
  "score": 0-100,
  "feedback": "brief explanation of your evaluation"
}

Be strict but fair. A passing output must address the task description meaningfully.`;
}

export async function evaluateTaskOutput(
  taskName: string,
  taskDescription: string,
  expectedOutput: string,
  actualOutput: string,
  criteria?: string,
  requiredPatterns?: string[],
): Promise<EvalResult> {
  if (requiredPatterns && requiredPatterns.length > 0) {
    const missing = requiredPatterns.filter((p) => !actualOutput.includes(p));
    if (missing.length > 0) {
      return {
        pass: false,
        feedback: `Required patterns missing in output: ${missing.join(', ')}`,
        score: 0,
      };
    }
  }

  const prompt = buildEvalPrompt(taskName, taskDescription, expectedOutput, actualOutput, criteria);
  const resolvedPrompt = await resolvePromptText({
    promptKey: 'workteam.eval',
    variables: {
      taskName,
      taskDescription,
      expectedOutput: expectedOutput || '(not specified)',
      criteriaBlock: criteria ? `## Evaluation Criteria\n${criteria}\n` : '',
      actualOutput,
    },
    fallbackText: prompt,
  });

  let raw: string;
  try {
    const directPrompt = buildDirectProviderPromptEnvelope({
      userPrompt: resolvedPrompt.text,
    });
    raw = await generateTextWithDefaultProvider(resolvedPrompt.text, {
      temperature: EVAL_TEMPERATURE,
      promptTrace: {
        promptKey: 'workteam.eval',
        featureScope: 'workteam',
        stableSystemPrompt: directPrompt.envelope.stableSystemPrompt,
        volatileSystemPrompt: directPrompt.envelope.volatileSystemPrompt,
        contextBlocks: directPrompt.envelope.contextBlocks,
        userPromptText: directPrompt.envelope.userPrompt,
        providerInputText: directPrompt.envelope.providerInputText,
        segments: directPrompt.segments,
        stablePrefixFingerprint: directPrompt.envelope.stablePrefixFingerprint || null,
        cacheFingerprint: directPrompt.envelope.cacheFingerprint || null,
        metadata: { taskName },
      },
    });
  } catch (err) {
    // pass:true avoids consuming eval retries on infrastructure errors (network/provider failures)
    logger.warn({ err, taskName }, 'workteam evaluation: LLM call failed (infra)');
    return { pass: true, feedback: '[infra-error] Evaluation skipped due to LLM call failure — manual review recommended' };
  }

  try {
    const trimmed = raw.trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i;
    const m = trimmed.match(fence);
    const json = m?.[1]?.trim() ?? trimmed;

    const parsed = JSON.parse(json) as Record<string, unknown>;
    return {
      pass: parsed.pass === true,
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : 'No feedback provided',
      score: typeof parsed.score === 'number' ? parsed.score : undefined,
    };
  } catch (err) {
    logger.warn({ err, taskName }, 'workteam evaluation: failed to parse LLM response');
    return { pass: false, feedback: 'Evaluation failed: could not parse LLM response — task output may not meet quality criteria' };
  }
}
