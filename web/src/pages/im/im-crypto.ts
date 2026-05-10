export interface ImCryptoSource {
  subtle?: SubtleCrypto;
  webkitSubtle?: SubtleCrypto;
}

export function getImSubtleCrypto(
  source: ImCryptoSource | undefined = globalThis.crypto as
    | ImCryptoSource
    | undefined,
): SubtleCrypto {
  const subtle = source?.subtle || source?.webkitSubtle;
  if (subtle) return subtle;

  const secureContextNote =
    typeof globalThis.isSecureContext === 'boolean' &&
    !globalThis.isSecureContext
      ? ' 当前页面不是安全上下文，请使用 HTTPS 或 localhost。'
      : '';
  throw new Error(
    `端到端加密需要浏览器支持 Web Crypto crypto.subtle。${secureContextNote}`,
  );
}
