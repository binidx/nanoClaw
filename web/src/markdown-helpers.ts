export function createMarkdownHeadingId(prefix: string, index: number, text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  const safePrefix = prefix.trim() || 'md';
  return `${safePrefix}-${index}-${slug || 'section'}`;
}
