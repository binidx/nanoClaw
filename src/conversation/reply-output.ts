function normalizeReplyText(text: string): string {
  return text.trim();
}

export function mergeStreamingText(current: string, next: string): string {
  if (!next) return current;
  if (!current) return next;
  if (next === current) return current;
  if (next.includes(current)) return next;
  if (current.includes(next)) return current;

  const maxOverlap = Math.min(current.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (current.endsWith(next.slice(0, overlap))) {
      return current + next.slice(overlap);
    }
  }

  return current + next;
}

export function appendReplyPart(parts: string[], candidate: string): string[] {
  const cleanCandidate = normalizeReplyText(candidate);
  if (!cleanCandidate) return parts;

  if (parts.length === 0) {
    return [candidate];
  }

  const nextParts = [...parts];
  const lastPart = nextParts[nextParts.length - 1];
  const cleanLastPart = normalizeReplyText(lastPart);

  if (cleanCandidate === cleanLastPart) {
    return nextParts;
  }

  if (cleanCandidate.includes(cleanLastPart)) {
    nextParts[nextParts.length - 1] = candidate;
    return nextParts;
  }

  if (cleanLastPart.includes(cleanCandidate)) {
    return nextParts;
  }

  nextParts.push(candidate);
  return nextParts;
}

export function resolveFinalReplyText(
  parts: string[],
  streamedText: string,
): string {
  const normalizedParts = parts.reduce<string[]>((acc, part) => {
    return appendReplyPart(acc, part);
  }, []);

  const combined = normalizedParts
    .map((part) => normalizeReplyText(part))
    .filter(Boolean)
    .join('\n\n');
  const stream = normalizeReplyText(streamedText);

  if (!combined) return stream;
  if (!stream) return combined;
  if (combined === stream) return combined;
  if (combined.endsWith(stream)) return combined;
  if (stream.endsWith(combined)) return stream;

  return combined;
}
