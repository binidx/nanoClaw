import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefCallback } from 'react';
import type { Terminal as XtermTerminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

import i18n from '../i18n/index.ts';
import type { NavPage } from '../app-types';

interface UseTerminalSessionOptions {
  page: NavPage;
  setPage: (page: NavPage) => void;
  terminalEnabled: boolean;
  activeJid: string | null;
}

export const TERMINAL_MOUNT_RETRY_LIMIT = 8;
export const TERMINAL_MOUNT_RETRY_DELAY_MS = 60;

type TerminalHostLike = {
  clientWidth: number;
  clientHeight: number;
};

type LocationLike = {
  protocol: string;
  host: string;
};

export function isRenderableTerminalHost(host: TerminalHostLike | null): boolean {
  return Boolean(host && host.clientWidth > 0 && host.clientHeight > 0);
}

export function shouldRetryTerminalMount(
  host: TerminalHostLike | null,
  attempt: number,
): boolean {
  return !isRenderableTerminalHost(host) && attempt < TERMINAL_MOUNT_RETRY_LIMIT;
}

export function buildTerminalWebSocketUrl(
  activeJid: string,
  currentLocation: LocationLike = globalThis.location ?? {
    protocol: 'http:',
    host: 'localhost',
  },
): string {
  const protocol = currentLocation.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ jid: activeJid });
  return `${protocol}//${currentLocation.host}/ws/terminal?${params.toString()}`;
}

export function useTerminalSession({
  page,
  setPage,
  terminalEnabled,
  activeJid,
}: UseTerminalSessionOptions) {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const termWsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeListenerRef = useRef<(() => void) | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const termDataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const layoutFrameRef = useRef<number | null>(null);
  const [terminalHost, setTerminalHost] = useState<HTMLDivElement | null>(null);

  const terminalRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    terminalHostRef.current = node;
    setTerminalHost(node);
  }, []);

  const closeTerminalSession = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (layoutFrameRef.current !== null) {
      window.cancelAnimationFrame(layoutFrameRef.current);
      layoutFrameRef.current = null;
    }
    const ws = termWsRef.current;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
    termWsRef.current = null;
    termDataDisposableRef.current?.dispose?.();
    termDataDisposableRef.current = null;
    if (resizeListenerRef.current) {
      window.removeEventListener('resize', resizeListenerRef.current);
      resizeListenerRef.current = null;
    }
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    xtermRef.current?.dispose();
    xtermRef.current = null;
    fitAddonRef.current = null;
  }, []);

  const openTerminal = useCallback(() => {
    if (!terminalEnabled) return;
    setPage('terminal');
  }, [setPage, terminalEnabled]);

  useEffect(() => {
    if (!terminalEnabled && page === 'terminal') {
      closeTerminalSession();
      setPage('chat');
      return;
    }

    if (page !== 'terminal' || !terminalEnabled || !activeJid) {
      closeTerminalSession();
      return;
    }

    if (!terminalHost) return;

    let cancelled = false;
    let mountAttempts = 0;

    const mountTerminal = async () => {
      try {
        const host = terminalHostRef.current;
        if (!host || cancelled || xtermRef.current) return;

        if (!isRenderableTerminalHost(host)) {
          if (shouldRetryTerminalMount(host, mountAttempts)) {
            mountAttempts += 1;
            retryTimerRef.current = window.setTimeout(() => {
              retryTimerRef.current = null;
              void mountTerminal();
            }, TERMINAL_MOUNT_RETRY_DELAY_MS);
            return;
          }

          host.textContent =
            i18n.t('terminal.auto.mountTimeout');
          return;
        }

        const { Terminal } = await import('@xterm/xterm');
        const { FitAddon } = await import('@xterm/addon-fit');
        await import('@xterm/xterm/css/xterm.css');
        const currentHost = terminalHostRef.current;
        if (!currentHost || cancelled || xtermRef.current) return;

        if (!isRenderableTerminalHost(currentHost)) {
          if (shouldRetryTerminalMount(currentHost, mountAttempts)) {
            mountAttempts += 1;
            retryTimerRef.current = window.setTimeout(() => {
              retryTimerRef.current = null;
              void mountTerminal();
            }, TERMINAL_MOUNT_RETRY_DELAY_MS);
            return;
          }

          currentHost.textContent =
            i18n.t('terminal.auto.mountTimeout');
          return;
        }

        const term = new Terminal({
          fontSize: 13,
          fontFamily: "'Consolas', 'Courier New', monospace",
          cursorBlink: true,
          convertEol: true,
          theme: { background: '#111827', foreground: '#e5e7eb' },
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(currentHost);
        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        const ws = new WebSocket(buildTerminalWebSocketUrl(activeJid));
        termWsRef.current = ws;

        const sendResize = () => {
          fitAddon.fit();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'resize',
                cols: term.cols,
                rows: term.rows,
              }),
            );
          }
        };

        const syncLayout = () => {
          if (layoutFrameRef.current !== null) {
            window.cancelAnimationFrame(layoutFrameRef.current);
          }
          layoutFrameRef.current = window.requestAnimationFrame(() => {
            layoutFrameRef.current = window.requestAnimationFrame(() => {
              layoutFrameRef.current = null;
              if (!cancelled && xtermRef.current === term) {
                sendResize();
              }
            });
          });
        };

        resizeListenerRef.current = syncLayout;
        window.addEventListener('resize', syncLayout);
        if ('ResizeObserver' in window) {
          const resizeObserver = new ResizeObserver(syncLayout);
          resizeObserver.observe(currentHost);
          if (currentHost.parentElement) {
            resizeObserver.observe(currentHost.parentElement);
          }
          resizeObserverRef.current = resizeObserver;
        }

        ws.onopen = () => {
          syncLayout();
          term.focus();
        };
        ws.onmessage = (event) =>
          term.write(typeof event.data === 'string' ? event.data : '');
        ws.onclose = () => term.write('\r\n[Terminal disconnected]\r\n');
        ws.onerror = () => term.write('\r\n[Terminal connection error]\r\n');

        const disposable = term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        });
        termDataDisposableRef.current = disposable;
        syncLayout();
      } catch {
        const currentHost = terminalHostRef.current;
        if (currentHost) {
          currentHost.textContent =
            'Terminal requires xterm package. Install: cd web && npm i';
        }
      }
    };

    void mountTerminal();

    return () => {
      cancelled = true;
      closeTerminalSession();
    };
  }, [activeJid, closeTerminalSession, page, setPage, terminalEnabled, terminalHost]);

  useEffect(() => {
    if (!terminalEnabled && page === 'terminal') {
      setPage('chat');
    }
  }, [page, setPage, terminalEnabled]);

  return { terminalRef, openTerminal };
}
