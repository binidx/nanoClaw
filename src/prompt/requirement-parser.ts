import { createModuleLogger } from '../logger.js';
import { resolvePromptText } from './prompt-service.js';
import { generateTextWithDefaultProvider } from '../provider/provider-api.js';
import { extractJsonFromLlmText } from '../workteam/smart-creator.js';
import { t } from '../i18n/index.js';

const logger = createModuleLogger('requirement-parser');

export interface ParsedRequirement {
  title: string;
  description: string;
  acceptance_criteria: string[];
  priority: 'high' | 'medium' | 'low';
  modules: string[];
  estimated_complexity: 'simple' | 'moderate' | 'complex';
}

export interface RequirementParseResult {
  requirements: ParsedRequirement[];
  open_questions: string[];
  raw_input_summary: string;
}

const PARSER_TEMPERATURE = 0.3;
const MAX_RETRIES = 2;

export function buildParserPrompt(rawInput: string): string {
  return `You are a senior product manager analyzing user requirements for a software project.

## Task

Parse the following input into structured requirements. The input may be:
- Natural language text describing features or changes
- Extracted text from documents (XLSX, PDF, DOCX, Markdown, HTML)
- A mix of the above

## Output Format

Return **only** valid JSON matching this schema:

{
  "requirements": [
    {
      "title": "short descriptive title",
      "description": "detailed description of what needs to be done",
      "acceptance_criteria": ["criterion 1", "criterion 2"],
      "priority": "high" | "medium" | "low",
      "modules": ["module or file area affected"],
      "estimated_complexity": "simple" | "moderate" | "complex"
    }
  ],
  "open_questions": ["question that needs clarification from user"],
  "raw_input_summary": "1-2 sentence summary of the input"
}

Rules:
- Extract ALL distinct requirements from the input
- Each requirement must have at least one acceptance criterion
- Priority: high = blocking/critical, medium = important, low = nice-to-have
- Complexity: simple = <1 day, moderate = 1-3 days, complex = >3 days
- open_questions: anything ambiguous or underspecified that needs user clarification
- If the input is too vague to extract requirements, return empty requirements with open_questions

## User Input

${rawInput}`;
}

function normalizeRequirement(raw: unknown): ParsedRequirement | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const description = typeof o.description === 'string' ? o.description.trim() : '';
  if (!title || !description) return null;

  const acceptance_criteria = Array.isArray(o.acceptance_criteria)
    ? (o.acceptance_criteria as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
  if (acceptance_criteria.length === 0) acceptance_criteria.push(t('errors.auto_0a8d6e', {}, undefined));

  const validPriorities = ['high', 'medium', 'low'] as const;
  const priority = validPriorities.includes(o.priority as typeof validPriorities[number])
    ? (o.priority as typeof validPriorities[number])
    : 'medium';

  const modules = Array.isArray(o.modules)
    ? (o.modules as unknown[]).filter((m): m is string => typeof m === 'string')
    : [];

  const validComplexities = ['simple', 'moderate', 'complex'] as const;
  const estimated_complexity = validComplexities.includes(o.estimated_complexity as typeof validComplexities[number])
    ? (o.estimated_complexity as typeof validComplexities[number])
    : 'moderate';

  return { title, description, acceptance_criteria, priority, modules, estimated_complexity };
}

function parseParserResponse(raw: string): RequirementParseResult | null {
  try {
    const json = extractJsonFromLlmText(raw);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    const requirements: ParsedRequirement[] = [];
    if (Array.isArray(parsed.requirements)) {
      for (const r of parsed.requirements) {
        const nr = normalizeRequirement(r);
        if (nr) requirements.push(nr);
      }
    }

    const open_questions = Array.isArray(parsed.open_questions)
      ? (parsed.open_questions as unknown[]).filter((q): q is string => typeof q === 'string')
      : [];

    const raw_input_summary = typeof parsed.raw_input_summary === 'string'
      ? parsed.raw_input_summary
      : '';

    return { requirements, open_questions, raw_input_summary };
  } catch {
    return null;
  }
}

const MAX_INPUT_CHARS = 100_000;

export async function parseRequirements(rawInput: string): Promise<RequirementParseResult> {
  const truncated = rawInput.length > MAX_INPUT_CHARS
    ? rawInput.slice(0, MAX_INPUT_CHARS) + `\n\n[... 输入已截断，仅处理前 ${MAX_INPUT_CHARS.toLocaleString()} 字符 ...]`
    : rawInput;
  const prompt = (
    await resolvePromptText({
      promptKey: 'requirement_parser.base',
      variables: { rawInput: truncated },
      fallbackText: buildParserPrompt(truncated),
    })
  ).text;
  logger.info({ inputLength: rawInput.length, truncated: rawInput.length > MAX_INPUT_CHARS }, 'requirement-parser: starting');

  let lastError: string | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let actualPrompt = prompt;
    if (attempt > 0) {
      const retrySuffix = await resolvePromptText({
        promptKey: 'requirement_parser.retry_suffix',
        variables: {
          error: lastError || 'unknown parse error',
        },
        fallbackText: `[IMPORTANT: Previous response failed to parse. Error: ${lastError}. Return ONLY valid JSON.]`,
      });
      actualPrompt = `${prompt}\n\n${retrySuffix.text}`;
    }
    try {
      const raw = await generateTextWithDefaultProvider(actualPrompt, {
        temperature: PARSER_TEMPERATURE,
        promptTrace: {
          promptKey: 'requirement_parser.base',
          featureScope: 'requirement_parser',
          metadata: {
            attempt,
            inputLength: rawInput.length,
          },
        },
      });
      const result = parseParserResponse(raw);
      if (result) {
        logger.info(
          { attempt, reqCount: result.requirements.length, questions: result.open_questions.length },
          'requirement-parser: success',
        );
        return result;
      }
      lastError = 'Response was not valid JSON or schema mismatch';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ attempt, err: lastError }, 'requirement-parser: LLM call failed');
    }
  }

  logger.warn({ lastError }, 'requirement-parser: all retries exhausted, returning empty');
  return {
    requirements: [],
    open_questions: [t('errors.auto_fb49c3', {}, undefined)],
    raw_input_summary: rawInput.slice(0, 200),
  };
}

export function formatRequirementsForConfirmation(result: RequirementParseResult): string {
  const parts: string[] = [];

  if (result.raw_input_summary) {
    parts.push(`**输入摘要**: ${result.raw_input_summary}`);
  }

  if (result.requirements.length > 0) {
    parts.push(`\n**解析出 ${result.requirements.length} 条需求**:\n`);
    for (let i = 0; i < result.requirements.length; i++) {
      const r = result.requirements[i]!;
      parts.push(`${i + 1}. **${r.title}** [${r.priority}/${r.estimated_complexity}]`);
      parts.push(`   ${r.description}`);
      parts.push(`   验收标准: ${r.acceptance_criteria.join('; ')}`);
      if (r.modules.length > 0) parts.push(`   涉及模块: ${r.modules.join(', ')}`);
    }
  }

  if (result.open_questions.length > 0) {
    parts.push(`\n**待澄清问题**:`);
    for (const q of result.open_questions) {
      parts.push(`- ${q}`);
    }
  }

  return parts.join('\n');
}
