export interface ChatHistoryTextPart {
  type?: string;
  text?: string;
}

export interface ChatHistoryMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | ChatHistoryTextPart[] | null;
}

export function extractChatMessageText(
  content: ChatHistoryMessage['content'],
): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is ChatHistoryTextPart =>
        part?.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => String(part.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function buildResponsesHistoryBridgePrompt(
  history: ChatHistoryMessage[],
  promptText: string,
): string {
  const transcriptLines: string[] = [];
  let totalChars = 0;

  for (let index = history.length - 1; index >= 1; index--) {
    const message = history[index];
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = extractChatMessageText(message.content);
    if (!text) continue;
    const line = `${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
    transcriptLines.push(line);
    totalChars += line.length;
    if (transcriptLines.length >= 12 || totalChars >= 12000) break;
  }

  if (transcriptLines.length === 0) return promptText;

  return [
    'Conversation history before this turn:',
    ...transcriptLines.reverse(),
    '',
    'Current user message:',
    promptText,
  ].join('\n');
}
