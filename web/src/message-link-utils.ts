const DETECTED_URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;
const IMAGE_URL_REGEX =
  /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)(?:$|[?#&])/i;
const IMAGE_FILE_NAME_REGEX =
  /([^/?#=&]+\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp))(?=$|[?#&])/i;
const TRAILING_URL_PUNCTUATION_REGEX = /[.,!?;:]+$/;

export interface DetectedUrlMatch {
  index: number;
  raw: string;
  url: string;
  suffix: string;
}

function splitTrailingUrlPunctuation(raw: string): {
  url: string;
  suffix: string;
} {
  const suffix = raw.match(TRAILING_URL_PUNCTUATION_REGEX)?.[0] || '';
  if (!suffix) return { url: raw, suffix: '' };
  const url = raw.slice(0, -suffix.length);
  return url ? { url, suffix } : { url: raw, suffix: '' };
}

export function findDetectedUrls(text: string): DetectedUrlMatch[] {
  const matches: DetectedUrlMatch[] = [];
  const regex = new RegExp(DETECTED_URL_REGEX.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text))) {
    const raw = match[0];
    const { url, suffix } = splitTrailingUrlPunctuation(raw);
    matches.push({
      index: match.index,
      raw,
      url,
      suffix,
    });
  }

  return matches;
}

export function extractDetectedUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const match of findDetectedUrls(text)) {
    if (seen.has(match.url)) continue;
    seen.add(match.url);
    urls.push(match.url);
  }

  return urls;
}

export function isLikelyImageUrl(url: string): boolean {
  return IMAGE_URL_REGEX.test(url);
}

export function getImageAltText(url: string): string {
  const fileName =
    url.match(IMAGE_FILE_NAME_REGEX)?.[1] ||
    url.split('?')[0].split('/').filter(Boolean).pop() ||
    'image';

  try {
    return decodeURIComponent(fileName);
  } catch {
    return fileName;
  }
}
