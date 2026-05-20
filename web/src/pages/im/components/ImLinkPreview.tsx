import { useEffect, useState } from 'react';
import type { LinkPreviewData } from '../im-api';
import { getImLinkPreview } from '../im-api';

const cache = new Map<string, LinkPreviewData | null>();

export function ImLinkPreview({
  url,
  chatJid,
}: {
  url: string;
  chatJid: string;
}) {
  const cacheKey = `${chatJid}\n${url}`;
  const [data, setData] = useState<LinkPreviewData | null | undefined>(
    cache.has(cacheKey) ? cache.get(cacheKey) : undefined,
  );

  useEffect(() => {
    setData(cache.has(cacheKey) ? cache.get(cacheKey) : undefined);
  }, [cacheKey]);

  useEffect(() => {
    if (data !== undefined) return;
    let cancelled = false;
    void getImLinkPreview(url, chatJid).then((d) => {
      cache.set(cacheKey, d);
      if (!cancelled) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, chatJid, url, data]);

  if (!data) return null;
  if (!data.title && !data.description) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'flex',
        gap: 10,
        padding: '8px 10px',
        marginTop: 4,
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'var(--surface-subtle)',
        textDecoration: 'none',
        color: 'var(--text-primary)',
        fontSize: 12,
        overflow: 'hidden',
      }}
    >
      {data.imageUrl ? (
        <img
          src={data.imageUrl}
          alt=""
          style={{
            width: 60,
            height: 60,
            objectFit: 'cover',
            borderRadius: 6,
            flexShrink: 0,
          }}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : null}
      <div style={{ minWidth: 0, flex: 1 }}>
        {data.siteName ? (
          <div
            className="settings-hint"
            style={{ fontSize: 10, marginBottom: 2 }}
          >
            {data.siteName}
          </div>
        ) : null}
        {data.title ? (
          <div
            style={{
              fontWeight: 600,
              fontSize: 13,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {data.title}
          </div>
        ) : null}
        {data.description ? (
          <div
            className="settings-hint"
            style={{
              fontSize: 11,
              marginTop: 2,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {data.description}
          </div>
        ) : null}
      </div>
    </a>
  );
}
