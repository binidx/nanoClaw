let loaded = false;
let loadPromise: Promise<void> | null = null;

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

export function ensureCubismSDK(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    if (!(window as any).Live2DCubismCore) {
      await injectScript('/lib/live2dcubismcore.min.js');
    }
    loaded = true;
  })();

  return loadPromise;
}
