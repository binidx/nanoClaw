interface ScheduledTaskPromptUploadedFile {
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
}

export interface ScheduledTaskPromptPayload {
  text: string;
  uploadedFiles?: ScheduledTaskPromptUploadedFile[];
}

const SCHEDULED_TASK_DISPATCH_PREFIX = [
  '[SYSTEM DISPATCH]',
  'Execute the instruction below now.',
  'Treat it as the current assistant action to perform, not as a request to create or configure a task.',
  'Do not mention scheduling, automation, reminder setup, task creation, task IDs, configuration details, or timing metadata unless the instruction explicitly asks for them.',
  'Do not say that a reminder or task has been created, scheduled, completed, or configured.',
  'Reply only with the actual reminder, result, or content the instruction calls for.',
].join(' ');

export function buildScheduledTaskPrompt(
  prompt: ScheduledTaskPromptPayload,
): ScheduledTaskPromptPayload {
  const text = prompt.text.trim();
  return {
    ...prompt,
    text: text
      ? `${SCHEDULED_TASK_DISPATCH_PREFIX}\n\n${text}`
      : SCHEDULED_TASK_DISPATCH_PREFIX,
  };
}
