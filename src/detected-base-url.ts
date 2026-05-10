let detectedBaseUrl = '';

export function setDetectedBaseUrl(url: string): void {
  detectedBaseUrl = url.replace(/\/+$/, '');
}

export function getDetectedBaseUrl(): string {
  return detectedBaseUrl;
}
