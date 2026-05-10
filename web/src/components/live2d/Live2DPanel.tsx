import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { Live2DPreferences, Live2DEmotion, Live2DModelInfo } from '../../app-types';
import { useMobileDetect } from '../../hooks/useMobileDetect';
import { ensureCubismSDK } from './cubism-sdk';

/* ── module-level caches ──────────────────────────────────── */

const entryFileCache = new Map<string, string>();
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

async function resolveEntry(modelId: string): Promise<string | null> {
  if (entryFileCache.has(modelId)) return entryFileCache.get(modelId)!;
  const res = await fetch('/api/live2d/models');
  if (!res.ok) return null;
  const list: Live2DModelInfo[] = await res.json();
  for (const m of list) if (m.entryFile) entryFileCache.set(m.id, m.entryFile);
  return entryFileCache.get(modelId) ?? null;
}

/* ── tap motion helper ───────────────────────────────────── */

function playTapMotion(model: any) {
  try {
    const mm = model?.internalModel?.motionManager;
    if (!mm) return;
    const groups = Object.keys(mm.definitions || {});
    const tapGroups = groups.filter((g: string) => {
      const l = g.toLowerCase();
      return l.includes('tap') || l.includes('touch') || l.includes('click') || l.includes('flick');
    });
    if (!tapGroups.length) return;
    const grp = tapGroups[Math.floor(Math.random() * tapGroups.length)];
    const defs = mm.definitions[grp];
    const idx = Array.isArray(defs) ? Math.floor(Math.random() * defs.length) : 0;
    mm.startMotion(grp, idx, 2);
  } catch { /* ok */ }
}

/* ── component ───────────────────────────────────────────── */

const DRAG_THRESHOLD = 4;

interface Props {
  modelId: string | null;
  preferences: Live2DPreferences;
  currentEmotion: Live2DEmotion | null;
  onClose: () => void;
  onOpenSettings?: () => void;
  onScaleChange?: (scale: number) => void;
}

export function Live2DPanel({ modelId, preferences, currentEmotion, onClose, onOpenSettings, onScaleChange }: Props) {
  const { t } = useTranslation('live2d');
  const isMobile = useMobileDetect();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const hitboxRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<any>(null);
  const modelRef = useRef<any>(null);
  const loadedIdRef = useRef<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [dragOff, setDragOff] = useState({ x: 0, y: 0 });

  const emotionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef({ on: false, sx: 0, sy: 0, ox: 0, oy: 0, moved: false });

  const W = isMobile ? Math.round((preferences.panelWidth || 280) * 0.58) : (preferences.panelWidth || 280);
  const H = Math.round(W * 1.5);
  const userScale = preferences.modelScale || 1.0;

  const onHoverEnter = useCallback(() => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    setHovered(true);
  }, []);

  const onHoverLeave = useCallback(() => {
    hoverTimer.current = setTimeout(() => setHovered(false), 200);
  }, []);

  const destroyApp = useCallback(() => {
    if (emotionTimer.current) clearTimeout(emotionTimer.current);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (appRef.current) {
      appRef.current.destroy(true, { children: true });
      appRef.current = null;
    }
    modelRef.current = null;
    loadedIdRef.current = null;
  }, []);

  /* ── load model ─────────────────────────────────────────── */

  const loadModel = useCallback(async () => {
    if (!modelId || !canvasRef.current) return;
    if (loadedIdRef.current === modelId && modelRef.current) return;

    destroyApp();
    setLoading(true);
    setError(null);

    try {
      await ensureCubismSDK();
      const entry = await resolveEntry(modelId);
      if (!entry) { setError(t('panel.modelNotFound')); setLoading(false); return; }

      const { PIXI, Live2DModel } = await getModules();

      const dpr = window.devicePixelRatio || 1;
      const app = new PIXI.Application({
        view: canvasRef.current,
        width: W,
        height: H,
        backgroundAlpha: 0,
        resolution: dpr * Math.max(userScale, 1),
        autoDensity: true,
      });
      appRef.current = app;

      const url = `/api/live2d/models/${modelId}/files/${entry}`;
      const model = await Live2DModel.from(url, {
        autoInteract: false,
        autoUpdate: false,
      });

      const baseScale = Math.min((W * 0.7) / model.width, (H * 0.85) / model.height);
      model.scale.set(baseScale);
      model.x = W * 0.5;
      model.y = H * 0.92 + (preferences.modelOffsetY || 0);
      model.anchor.set(0.5, 1);

      patchLive2DEvents(model);
      app.stage.addChild(model as any);
      modelRef.current = model;
      loadedIdRef.current = modelId;

      const ticker = (app as any).ticker;
      if (ticker) {
        ticker.add(() => {
          try { model.update(ticker.elapsedMS); } catch { /* ok */ }
        });
      }
    } catch (e) {
      setError(t('panel.loadFailed', { error: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [modelId, W, H, destroyApp]);

  useEffect(() => { loadModel(); }, [loadModel]);
  useEffect(() => () => { destroyApp(); }, [destroyApp]);

  /* ── reactively apply offsetY ──────────────────────────── */

  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    model.y = H * 0.92 + (preferences.modelOffsetY || 0);
  }, [preferences.modelOffsetY, H]);

  /* ── manual focus tracking (eyes follow cursor) ─────────── */

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const m = modelRef.current;
      const cv = canvasRef.current;
      if (!m || !cv || collapsed) return;
      try {
        const rect = cv.getBoundingClientRect();
        const scale = scaleRef.current || 1;
        m.focus(
          (e.clientX - rect.left) / scale,
          (e.clientY - rect.top) / scale,
        );
      } catch { /* ok */ }
    }
    document.addEventListener('mousemove', onMove, { passive: true });
    return () => document.removeEventListener('mousemove', onMove);
  }, [collapsed]);

  /* ── emotion-driven motion ──────────────────────────────── */

  useEffect(() => {
    if (!currentEmotion || currentEmotion === 'neutral' || !modelRef.current) return;
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
      const candidates = emoMap[currentEmotion] || [];
      const groups = Object.keys(mm.definitions || {});
      const matched = groups.find((g: string) => candidates.some((c) => g.toLowerCase().includes(c)));
      if (matched) {
        const defs = mm.definitions[matched];
        const idx = Array.isArray(defs) ? Math.floor(Math.random() * defs.length) : 0;
        mm.startMotion(matched, idx, 2);
      }
      if (emotionTimer.current) clearTimeout(emotionTimer.current);
      emotionTimer.current = setTimeout(() => {
        const idle = groups.find((g: string) => g.toLowerCase().includes('idle'));
        if (idle) mm.startMotion(idle, 0);
      }, 4000);
    } catch { /* ok */ }
  }, [currentEmotion]);

  /* ── collapse: pause / resume ticker ────────────────────── */

  useEffect(() => {
    const t = (appRef.current as any)?.ticker;
    if (!t) return;
    if (collapsed) {
      t.stop();
    } else {
      t.start();
    }
  }, [collapsed]);

  /* ── wheel / pinch zoom (CSS transform — no PixiJS ops) ── */

  const scaleRef = useRef(userScale);
  scaleRef.current = userScale;

  const pinchRef = useRef<{ startDist: number; startScale: number } | null>(null);

  useEffect(() => {
    const hitbox = hitboxRef.current;
    const area = canvasAreaRef.current;
    if (!hitbox || !area) return;

    function applyZoom(next: number) {
      const clamped = Math.max(0.3, Math.min(3.0, Math.round(next * 20) / 20));
      if (clamped === scaleRef.current) return;
      scaleRef.current = clamped;
      if (area) area.style.transform = `scale(${clamped})`;
      onScaleChange?.(clamped);
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      applyZoom(scaleRef.current + delta);
    }

    function getTouchDist(e: TouchEvent) {
      const [a, b] = [e.touches[0], e.touches[1]];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 2) {
        pinchRef.current = { startDist: getTouchDist(e), startScale: scaleRef.current };
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (e.touches.length === 2 && pinchRef.current) {
        e.preventDefault();
        const dist = getTouchDist(e);
        const ratio = dist / pinchRef.current.startDist;
        applyZoom(pinchRef.current.startScale * ratio);
      }
    }

    function onTouchEnd() {
      pinchRef.current = null;
    }

    hitbox.addEventListener('wheel', onWheel, { passive: false });
    hitbox.addEventListener('touchstart', onTouchStart, { passive: true });
    hitbox.addEventListener('touchmove', onTouchMove, { passive: false });
    hitbox.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      hitbox.removeEventListener('wheel', onWheel);
      hitbox.removeEventListener('touchstart', onTouchStart);
      hitbox.removeEventListener('touchmove', onTouchMove);
      hitbox.removeEventListener('touchend', onTouchEnd);
    };
  }, [onScaleChange]);

  /* ── drag + tap ─────────────────────────────────────────── */

  const onDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.live2d-widget-toolbar, .live2d-fab')) return;
    drag.current = { on: true, sx: e.clientX, sy: e.clientY, ox: dragOff.x, oy: dragOff.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [dragOff]);

  const onMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.on) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) d.moved = true;
    if (d.moved) setDragOff({ x: d.ox + dx, y: d.oy + dy });
  }, []);

  const onUp = useCallback(() => {
    const d = drag.current;
    if (!d.on) return;
    if (!d.moved && modelRef.current) playTapMotion(modelRef.current);
    d.on = false;
  }, []);

  /* ── render ─────────────────────────────────────────────── */

  const side = preferences.position === 'left' ? 'left' : 'right';

  return (
    <div
      className={`live2d-widget${collapsed ? ' live2d-widget--collapsed' : ''}`}
      style={{
        [side]: 0, bottom: 0,
        width: W, height: H,
        opacity: (preferences.opacity || 100) / 100,
        transform: `translate(${dragOff.x}px, ${dragOff.y}px)`,
      }}
    >
      <div
        ref={canvasAreaRef}
        className="live2d-canvas-area"
        style={{
          width: W, height: H,
          transform: `scale(${userScale})`,
          transformOrigin: 'center bottom',
        }}
      >
        <div
          ref={hitboxRef}
          className="live2d-hitbox"
          onMouseEnter={onHoverEnter}
          onMouseLeave={onHoverLeave}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        {(hovered || loading || error) && !collapsed && (
          <div
            className="live2d-widget-toolbar"
            onMouseEnter={onHoverEnter}
            onMouseLeave={onHoverLeave}
          >
            {currentEmotion && currentEmotion !== 'neutral' && (
              <span className="live2d-emotion-tag">{currentEmotion}</span>
            )}
            {onOpenSettings && (
              <button onPointerDown={e => e.stopPropagation()} onClick={onOpenSettings} title={t('panel.openSettings')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            )}
            <button onPointerDown={e => e.stopPropagation()} onClick={() => setCollapsed(true)} title={t('panel.collapse')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button onPointerDown={e => e.stopPropagation()} onClick={onClose} title={t('panel.close')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        )}
        <canvas ref={canvasRef} style={{ width: W, height: H }} />
        {loading && <div className="live2d-widget-msg">{t('panel.loading')}</div>}
        {error && <div className="live2d-widget-msg live2d-widget-msg--err">{error}</div>}
      </div>

      {collapsed && (
        <button className="live2d-fab" onPointerDown={e => e.stopPropagation()} onClick={() => setCollapsed(false)} title={t('panel.expand', 'Live2D')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
            <line x1="9" y1="9" x2="9.01" y2="9" />
            <line x1="15" y1="9" x2="15.01" y2="9" />
          </svg>
        </button>
      )}
    </div>
  );
}
