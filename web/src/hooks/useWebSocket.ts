import { useCallback, useEffect, useRef } from 'react';

export function useWebSocket(
  onMessage: (data: Record<string, unknown>) => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<number>(0);
  const onMsgRef = useRef(onMessage);
  const connectedRef = useRef(false);
  const pendingSubscriptions = useRef<Set<string>>(new Set());
  const onReconnectRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onMsgRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    let alive = true;
    let ws: WebSocket | null = null;
    let backoff = 3000;
    const MAX_BACKOFF = 60_000;

    const connect = () => {
      if (!alive) return;
      if (
        ws &&
        (ws.readyState === WebSocket.CONNECTING ||
          ws.readyState === WebSocket.OPEN)
      ) {
        return;
      }
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        connectedRef.current = true;
        backoff = 3000;
        for (const jid of pendingSubscriptions.current) {
          ws!.send(JSON.stringify({ type: 'subscribe', jid }));
        }
        onReconnectRef.current?.();
      };
      ws.onmessage = (event) => {
        try {
          onMsgRef.current(JSON.parse(event.data));
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        connectedRef.current = false;
        if (alive) {
          reconnectTimer.current = window.setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
        }
      };
      ws.onerror = () => {
        connectedRef.current = false;
      };
    };

    connect();

    return () => {
      alive = false;
      clearTimeout(reconnectTimer.current);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      connectedRef.current = false;
    };
  }, []);

  const subscribe = useCallback((jid: string) => {
    pendingSubscriptions.current.add(jid);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', jid }));
    }
  }, []);

  const subscribeAll = useCallback((jids: string[]) => {
    const newSet = new Set(jids);
    const toSend = jids.filter((jid) => !pendingSubscriptions.current.has(jid));
    pendingSubscriptions.current = newSet;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      for (const jid of toSend) {
        wsRef.current.send(JSON.stringify({ type: 'subscribe', jid }));
      }
    }
  }, []);

  return { wsRef, subscribe, subscribeAll, connectedRef, onReconnectRef };
}
