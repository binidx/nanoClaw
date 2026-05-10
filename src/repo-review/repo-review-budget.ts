const REPO_REVIEW_PAYLOAD_BASE_OVERHEAD_BYTES = 512;

export function estimateRepoReviewPayloadBytes(input: {
  diffBytes: number;
  fileContentBytes: number;
  relatedFindingBytes: number;
  promptOverheadBytes?: number;
}): number {
  const diffBytes = Math.max(0, Math.trunc(input.diffBytes || 0));
  const fileContentBytes = Math.max(0, Math.trunc(input.fileContentBytes || 0));
  const relatedFindingBytes = Math.max(
    0,
    Math.trunc(input.relatedFindingBytes || 0),
  );
  const promptOverheadBytes = Math.max(
    0,
    Math.trunc(
      input.promptOverheadBytes ?? REPO_REVIEW_PAYLOAD_BASE_OVERHEAD_BYTES,
    ),
  );
  return diffBytes + fileContentBytes + relatedFindingBytes + promptOverheadBytes;
}

export function splitTasksByByteBudget<T extends { estimatedBytes: number }>(
  tasks: T[],
  maxBytes: number,
): T[][] {
  if (tasks.length === 0) return [];
  const effectiveMaxBytes = Math.max(1, Math.trunc(maxBytes || 0));
  const groups: T[][] = [];
  let currentGroup: T[] = [];
  let currentBytes = 0;

  const flushCurrentGroup = () => {
    if (currentGroup.length === 0) return;
    groups.push(currentGroup);
    currentGroup = [];
    currentBytes = 0;
  };

  for (const task of tasks) {
    const estimatedBytes = Math.max(0, Math.trunc(task.estimatedBytes || 0));
    if (estimatedBytes > effectiveMaxBytes) {
      flushCurrentGroup();
      groups.push([task]);
      continue;
    }
    if (
      currentGroup.length > 0 &&
      currentBytes + estimatedBytes > effectiveMaxBytes
    ) {
      flushCurrentGroup();
    }
    currentGroup.push(task);
    currentBytes += estimatedBytes;
  }

  flushCurrentGroup();
  return groups;
}
