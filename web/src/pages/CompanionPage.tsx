import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { Live2DConfig, Live2DEmotion } from '../app-types';
import { ensureCubismSDK } from '../components/live2d/cubism-sdk';
import './companion.css';

/* ── module-level caches (shared with Live2DPanel) ───────── */

let cachedPIXI: any = null;
let cachedLive2D: any = null;

async function getModules() {
  if (!cachedPIXI) cachedPIXI = await import('pixi.js');
  if (!cachedLive2D) cachedLive2D = await import('pixi-live2d-display/cubism4');
  return { PIXI: cachedPIXI, Live2DModel: cachedLive2D.Live2DModel };
}

function patchLive2DEvents(model: any): void {
  model.eventMode = 'none';
  model.interactiveChildren = false;
  if (typeof model.isInteractive !== 'function') {
    model.isInteractive = () => false;
  }
}

function getScaleParams(W: number) {
  const mobile = W < 900;
  return {
    widthRatio:  mobile ? 0.92 : 0.65,
    heightRatio: mobile ? 0.92 : 0.82,
    anchorY:     mobile ? 0.95 : 0.90,
  };
}

/* ── types ───────────────────────────────────────────────── */

interface Message {
  id: string;
  content: string;
  is_from_me: number;
  sender_name: string;
  timestamp: string;
}

interface CompanionPageProps {
  apiBase: string;
  live2dConfig: Live2DConfig | null;
  live2dEmotion: Live2DEmotion | null;
}

const TYPEWRITER_CHAR_MS = 30;

/* ── tap motion helper ───────────────────────────────────── */

function playTapMotion(model: any) {
  try {
    const mm = model?.internalModel?.motionManager;
    if (!mm) return;
    const groups = Object.keys(mm.definitions || {});
    const tapGroups = groups.filter((g: string) => {
      const l = g.toLowerCase();
      return l.includes('tap') || l.includes('touch') || l.includes('click');
    });
    if (!tapGroups.length) return;
    const grp = tapGroups[Math.floor(Math.random() * tapGroups.length)];
    const defs = mm.definitions[grp];
    const idx = Array.isArray(defs) ? Math.floor(Math.random() * defs.length) : 0;
    mm.startMotion(grp, idx, 2);
  } catch { /* ok */ }
}

/* ── component ───────────────────────────────────────────── */

export function CompanionPage({ apiBase, live2dConfig, live2dEmotion }: CompanionPageProps) {
  const { t } = useTranslation('live2d');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<any>(null);
  const modelRef = useRef<any>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const backlogEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const focusThrottleRef = useRef(0);
  const prevReplyIdRef = useRef<string | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [companionJid, setCompanionJid] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [typedText, setTypedText] = useState('');

  const prefs = live2dConfig?.preferences;
  const modelId = prefs?.selectedModelId;
  const live2dEnabled = Boolean(live2dConfig?.globalEnabled && prefs?.enabled);

  const { latestReply, latestUserMsg } = useMemo(() => {
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].is_from_me === 0) { lastUserIdx = i; break; }
    }
    let replyAfterUser: Message | null = null;
    if (lastUserIdx >= 0) {
      replyAfterUser = messages.slice(lastUserIdx + 1).find((m) => m.is_from_me === 1) ?? null;
    } else {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].is_from_me === 1) { replyAfterUser = messages[i]; break; }
      }
    }
    const lastUser = lastUserIdx >= 0 ? messages[lastUserIdx] : null;
    return { latestReply: replyAfterUser, latestUserMsg: lastUser };
  }, [messages]);

  /* ── ensure companion conversation exists ──────────────── */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/conversations`);
        if (!res.ok) {
          if (!cancelled) setInitError(t('companion.loadConvListFailed'));
          return;
        }
        const convs = await res.json();
        const companions = (convs as any[]).filter((c) => c.mode === 'companion');
        companions.sort((a, b) =>
          (b.last_message_time || '').localeCompare(a.last_message_time || ''),
        );
        if (companions.length > 0) {
          if (!cancelled) setCompanionJid(companions[0].jid);
          return;
        }
        const createRes = await fetch(`${apiBase}/api/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: t('companion.createConv'), type: 'web', mode: 'companion' }),
        });
        if (!createRes.ok) {
          if (!cancelled) setInitError(t('companion.createConvFailed'));
          return;
        }
        const data = await createRes.json();
        if (!cancelled) setCompanionJid(data.jid);
      } catch {
        if (!cancelled) setInitError(t('companion.networkFailed'));
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  /* ── load messages ─────────────────────────────────────── */

  const loadMessages = useCallback(async () => {
    if (!companionJid) return;
    try {
      const res = await fetch(
        `${apiBase}/api/conversations/${encodeURIComponent(companionJid)}/messages`,
      );
      if (!res.ok) return;
      const data = await res.json();
      const list: Message[] = Array.isArray(data.messages) ? data.messages : Array.isArray(data) ? data : [];
      setMessages(list);

      const last = list[list.length - 1];
      if (last && last.is_from_me === 0) {
        setBusy(true);
      } else if (last && last.is_from_me === 1) {
        setBusy(false);
      }
    } catch { /* offline */ }
  }, [apiBase, companionJid]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  /* ── poll for new messages (pause when tab hidden, adaptive interval) ── */

  useEffect(() => {
    if (!companionJid) return;

    const pollMs = busy ? 3_000 : 10_000;

    function startPoll() {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(loadMessages, pollMs);
    }
    function stopPoll() {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        loadMessages();
        startPoll();
      } else {
        stopPoll();
      }
    }

    startPoll();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopPoll();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [companionJid, loadMessages, busy]);

  /* ── send message ──────────────────────────────────────── */

  const sendMessage = useCallback(async () => {
    if (!companionJid || !input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setSending(true);
    setBusy(true);
    setSessionActive(true);
    setTypedText('');
    prevReplyIdRef.current = null;

    const optimistic: Message = {
      id: `local_${Date.now()}`,
      content: text,
      is_from_me: 0,
      sender_name: 'You',
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const res = await fetch(
        `${apiBase}/api/conversations/${encodeURIComponent(companionJid)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
        },
      );
      if (!res.ok) {
        setInput(text);
        setBusy(false);
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      }
    } catch {
      setInput(text);
      setBusy(false);
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
    }
    setSending(false);
  }, [apiBase, companionJid, input, sending]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  /* ── Live2D model loading ──────────────────────────────── */

  useEffect(() => {
    if (!live2dEnabled || !modelId || !canvasRef.current || !stageRef.current) {
      setModelError(null);
      return;
    }

    let destroyed = false;
    let pendingModel: any = null;

    (async () => {
      try {
        await ensureCubismSDK();

        const modelsRes = await fetch(`${apiBase}/api/live2d/models`);
        if (!modelsRes.ok) {
          if (!destroyed) {
            setModelError(t('panel.loadFailed', { error: `HTTP ${modelsRes.status}` }));
          }
          return;
        }
        const models = await modelsRes.json();
        const model = models.find((m: any) => m.id === modelId);
        if (!model) {
          if (!destroyed) setModelError(t('panel.modelNotFound'));
          return;
        }
        if (!model.entryFile || destroyed) {
          if (!destroyed) setModelError(t('panel.modelNotFound'));
          return;
        }

        const { PIXI, Live2DModel } = await getModules();

        const container = stageRef.current!;
        let W = container.clientWidth;
        let H = container.clientHeight;
        if (W <= 0 || H <= 0) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
          if (destroyed || !stageRef.current) return;
          W = stageRef.current.clientWidth;
          H = stageRef.current.clientHeight;
        }
        if (W <= 0 || H <= 0) {
          if (!destroyed) {
            setModelError(t('panel.loadFailed', { error: 'stage has no size' }));
          }
          return;
        }

        if (appRef.current) {
          appRef.current.destroy(true, { children: true });
          appRef.current = null;
        }

        const app = new PIXI.Application({
          view: canvasRef.current,
          width: W,
          height: H,
          backgroundAlpha: 0,
          resolution: window.devicePixelRatio || 1,
          autoDensity: true,
        });
        if (destroyed) { app.destroy(true); return; }
        appRef.current = app;

        const url = `${apiBase}/api/live2d/models/${modelId}/files/${encodeURI(model.entryFile)}`;
        const l2dModel = await Live2DModel.from(url, {
          autoInteract: false,
          autoUpdate: false,
        });
        pendingModel = l2dModel;
        if (destroyed) {
          try { l2dModel.destroy(); } catch { /* ok */ }
          return;
        }
        pendingModel = null;

        const sp = getScaleParams(W);
        const baseScale = Math.min((W * sp.widthRatio) / l2dModel.width, (H * sp.heightRatio) / l2dModel.height);
        l2dModel.scale.set(baseScale);
        l2dModel.x = W * 0.5;
        l2dModel.y = H * sp.anchorY + (prefs?.modelOffsetY || 0);
        l2dModel.anchor.set(0.5, 1);

        patchLive2DEvents(l2dModel);
        app.stage.addChild(l2dModel as any);
        modelRef.current = l2dModel;

        const ticker = (app as any).ticker;
        if (ticker) {
          ticker.add(() => {
            try { l2dModel.update(ticker.elapsedMS); } catch { /* ok */ }
          });
        }

        setModelError(null);
      } catch (e) {
        if (!destroyed) setModelError(t('companion.modelLoadFailed', { message: (e as Error).message }));
      }
    })();

    return () => {
      destroyed = true;
      if (pendingModel) {
        try { pendingModel.destroy(); } catch { /* ok */ }
      }
      if (appRef.current) {
        appRef.current.destroy(true, { children: true });
        appRef.current = null;
      }
      modelRef.current = null;
    };
  }, [apiBase, live2dEnabled, modelId, prefs?.modelOffsetY, t]);

  /* ── resize handler ────────────────────────────────────── */

  useEffect(() => {
    const handleResize = () => {
      const container = stageRef.current;
      const app = appRef.current;
      const model = modelRef.current;
      if (!container || !app || !model) return;

      const W = container.clientWidth;
      const H = container.clientHeight;
      app.renderer.resize(W, H);

      const sp = getScaleParams(W);
      const baseScale = Math.min((W * sp.widthRatio) / model.width, (H * sp.heightRatio) / model.height);
      model.scale.set(baseScale);
      model.x = W * 0.5;
      model.y = H * sp.anchorY + (prefs?.modelOffsetY || 0);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [prefs?.modelOffsetY]);

  /* ── focus tracking (throttled) ─────────────────────────── */

  useEffect(() => {
    function onMove(e: MouseEvent | TouchEvent) {
      const now = performance.now();
      if (now - focusThrottleRef.current < 32) return;
      focusThrottleRef.current = now;

      const m = modelRef.current;
      const cv = canvasRef.current;
      if (!m || !cv) return;
      try {
        const rect = cv.getBoundingClientRect();
        const clientX = 'touches' in e ? e.touches[0]?.clientX ?? 0 : e.clientX;
        const clientY = 'touches' in e ? e.touches[0]?.clientY ?? 0 : e.clientY;
        m.focus(clientX - rect.left, clientY - rect.top);
      } catch { /* ok */ }
    }
    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: true });
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
    };
  }, []);

  /* ── tap on model ──────────────────────────────────────── */

  const handleStageClick = useCallback(() => {
    if (modelRef.current) playTapMotion(modelRef.current);
  }, []);

  /* ── emotion-driven motion ─────────────────────────────── */

  useEffect(() => {
    if (!live2dEmotion || live2dEmotion === 'neutral' || !modelRef.current) return;
    const model = modelRef.current;
    try {
      const mm = model.internalModel?.motionManager;
      if (!mm) return;
      const emoMap: Record<string, string[]> = {
        happy: ['happy', 'joy', 'smile', 'laugh', 'tap'],
        sad: ['sad', 'cry', 'sorry'],
        angry: ['angry', 'rage'],
        surprised: ['surprised', 'shock', 'wow'],
        thinking: ['think', 'hmm', 'consider'],
      };
      const candidates = emoMap[live2dEmotion] || [];
      const groups = Object.keys(mm.definitions || {});
      const matched = groups.find((g: string) =>
        candidates.some((c) => g.toLowerCase().includes(c)),
      );
      if (matched) {
        const defs = mm.definitions[matched];
        const idx = Array.isArray(defs) ? Math.floor(Math.random() * defs.length) : 0;
        mm.startMotion(matched, idx, 2);
      }
    } catch { /* ok */ }
  }, [live2dEmotion]);

  /* ── typewriter effect for AI replies ─────────────────── */

  useEffect(() => {
    if (!latestReply || !sessionActive) {
      setTypedText('');
      return;
    }
    if (latestReply.id === prevReplyIdRef.current) return;
    prevReplyIdRef.current = latestReply.id;

    const fullText = latestReply.content;
    let idx = 0;
    setTypedText('');

    function tick() {
      idx++;
      if (idx <= fullText.length) {
        setTypedText(fullText.slice(0, idx));
        typingTimerRef.current = setTimeout(tick, TYPEWRITER_CHAR_MS);
      }
    }
    tick();

    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [latestReply, sessionActive]);

  /* ── backlog auto-scroll ───────────────────────────────── */

  useEffect(() => {
    if (backlogOpen && backlogEndRef.current) {
      backlogEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [backlogOpen, messages.length]);

  /* ── render ────────────────────────────────────────────── */

  const hasModel = live2dEnabled && modelId && !modelError;

  return (
    <div className="companion-page">
      {/* Live2D stage */}
      <div
        ref={stageRef}
        className="companion-stage"
        onClick={handleStageClick}
      >
        {hasModel ? (
          <canvas
            ref={canvasRef}
            style={{ width: '100%', height: '100%' }}
          />
        ) : (
          <div className="companion-empty">
            <h2>{t('companion.title')}</h2>
            <p>
              {initError || modelError || t('companion.configureHint')}
            </p>
          </div>
        )}

        {/* Speech bubble — typewriter AI reply (only after first send) */}
        {sessionActive && typedText && !backlogOpen && (
          <div className="companion-bubble">
            {typedText}
            {typedText.length < (latestReply?.content.length ?? 0) && (
              <span className="companion-cursor" />
            )}
          </div>
        )}

        {/* Thinking indicator — waiting for AI after user sends */}
        {sessionActive && busy && !typedText && latestUserMsg && !backlogOpen && (
          <div className="companion-bubble">
            <div className="companion-bubble-thinking">
              <span /><span /><span />
            </div>
          </div>
        )}

        {/* Emotion tag */}
        {live2dEmotion && live2dEmotion !== 'neutral' && (
          <div className="companion-emotion">{live2dEmotion}</div>
        )}
      </div>

      {/* Input bar */}
      <div className="companion-input-bar">
        <button
          className="companion-log-btn"
          onClick={() => setBacklogOpen(true)}
          title={t('companion.chatHistory')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
        </button>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={busy ? t('companion.thinking') : t('companion.saySomething')}
          disabled={!companionJid || sending}
        />
        <button
          className="companion-send-btn"
          onClick={sendMessage}
          disabled={!input.trim() || sending || !companionJid}
          title={t('companion.send')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>

      {/* Backlog overlay */}
      {backlogOpen && (
        <div className="companion-backlog-overlay">
          <div
            className="companion-backlog-backdrop"
            onClick={() => setBacklogOpen(false)}
          />
          <div className="companion-backlog-panel">
            <div className="companion-backlog-header">
              <span>{t('companion.chatHistory')}</span>
              <button
                className="companion-backlog-close"
                onClick={() => setBacklogOpen(false)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="companion-backlog-list">
              {messages.map((m) => (
                <div key={m.id} className="companion-backlog-item">
                  <span
                    className={`companion-backlog-sender${m.is_from_me === 0 ? ' companion-backlog-sender--user' : ''}`}
                  >
                    {m.is_from_me === 1 ? 'AI' : m.sender_name || 'You'}
                  </span>
                  <span className="companion-backlog-text">{m.content}</span>
                  <span className="companion-backlog-time">
                    {new Date(m.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))}
              <div ref={backlogEndRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
