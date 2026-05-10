import { renderMarkdownContent } from '../markdown';

export interface MarkdownContentProps {
  content: string;
  headingIdPrefix?: string;
}

export function MarkdownContent({ content, headingIdPrefix }: MarkdownContentProps) {
  return renderMarkdownContent(content, headingIdPrefix ? { headingIdPrefix } : undefined);
}
