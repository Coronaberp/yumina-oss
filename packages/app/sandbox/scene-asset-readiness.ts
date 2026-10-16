import { isPendingSandboxAssetUrl, loadSandboxAssetUrl, SANDBOX_ASSET_LOADING_EVENT, SANDBOX_ASSET_READY_EVENT } from './asset-bridge';

export type SceneAssetState = { ready: boolean; error?: boolean };
type ImageState = { source: string; state: 'pending' | 'ready' | 'error' };

/** Keep the actual scene mounted and loading, but covered and non-interactive
 * until its requested media, displayed images and used fonts can paint together.
 * This is an initial-entry gate only. Later scene/expression changes must not
 * cover an already running story. Never unlock the initial gate on a timer. */
export function observeSceneAssets(root: HTMLElement, onState: (state: SceneAssetState) => void): () => void {
  const doc = root.ownerDocument, win = doc.defaultView!;
  const images = new WeakMap<HTMLImageElement, ImageState>();
  const backgrounds = new Map<string, ImageState>();
  const originalVisibility = root.style.visibility, originalInert = root.inert;
  let stopped = false, queued = false, revision = 0, frame1 = 0, frame2 = 0;
  let last: SceneAssetState | undefined, fontPromise: Promise<FontFaceSet> | undefined;

  function publish(state: SceneAssetState) {
    if (stopped || last?.ready === state.ready && !!last?.error === !!state.error) return;
    last = state;
    root.style.visibility = state.ready ? originalVisibility : 'hidden';
    root.inert = state.ready ? originalInert : true;
    onState(state);
    if (state.ready) stop();
  }
  function visible(element: Element): boolean {
    if (!element.getClientRects().length || element.closest('[data-exiting="true"]')) return false;
    const bounds = element.getBoundingClientRect();
    return bounds.right >= 0 && bounds.bottom >= 0 && bounds.left <= win.innerWidth && bounds.top <= win.innerHeight;
  }
  function decode(image: HTMLImageElement, record: ImageState) {
    Promise.resolve().then(() => image.decode?.()).then(() => {
      record.state = 'ready'; schedule();
    }, () => {
      record.state = image.complete && image.naturalWidth > 0 ? 'ready' : 'error'; schedule();
    });
  }
  function imageState(image: HTMLImageElement): ImageState['state'] {
    if (isPendingSandboxAssetUrl(image.src)) return 'pending';
    const source = `${image.src}\n${image.srcset}\n${image.sizes}`;
    let record = images.get(image);
    if (!record || record.source !== source) {
      record = { source, state: 'pending' }; images.set(image, record);
    }
    if (!image.complete) return 'pending';
    if (!image.naturalWidth) return 'error';
    if (record.state === 'pending' && !decoded.has(record)) {
      decoded.add(record); decode(image, record);
    }
    return record.state;
  }
  const decoded = new WeakSet<ImageState>();
  function backgroundState(url: string): ImageState['state'] {
    let record = backgrounds.get(url);
    if (!record) {
      record = { source: url, state: 'pending' }; backgrounds.set(url, record);
      const current = record, image = new win.Image();
      image.onload = () => decode(image, current);
      image.onerror = () => { current.state = 'error'; schedule(); };
      void loadSandboxAssetUrl(url).then(resolved => {
        if (!stopped) image.src = resolved;
      }, () => { current.state = 'error'; schedule(); });
    }
    return record.state;
  }
  function inspect(): SceneAssetState {
    // Force used styles/fonts to be discovered before looking at fonts.ready.
    root.getBoundingClientRect();
    const states: ImageState['state'][] = [];
    const fontSpecs = new Set<string>();
    for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      if (!visible(element)) continue;
      if (element.tagName === 'IMG' && (element.getAttribute('src') || element.getAttribute('srcset'))) states.push(imageState(element as HTMLImageElement));
      const style = win.getComputedStyle(element);
      const background = style.backgroundImage;
      const drawsText = [...element.childNodes].some(node => node.nodeType === 3 && !!node.textContent?.trim()) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
      if (drawsText && style.fontFamily) fontSpecs.add(`${style.fontStyle || 'normal'} ${style.fontWeight || '400'} ${style.fontSize || '16px'} ${style.fontFamily}`);
      for (const match of background.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)) {
        const url = (match[1] ?? match[2] ?? match[3] ?? '').trim();
        if (url) states.push(url.includes('@asset:') || isPendingSandboxAssetUrl(url) ? 'pending' : backgroundState(url));
      }
      if (element.tagName === 'VIDEO') {
        const video = element as HTMLVideoElement;
        if (video.poster) states.push(backgroundState(video.poster));
        if (video.autoplay && (video.currentSrc || video.getAttribute('src') || video.querySelector('source'))) states.push(video.error ? 'error' : video.readyState >= 2 ? 'ready' : 'pending');
      }
    }
    const fonts = doc.fonts;
    if (fonts?.ready && fontPromise !== fonts.ready) {
      fontPromise = fonts.ready; void fontPromise.then(schedule, schedule);
    }
    // Only the displayed opening scene blocks entry. Prefetches and assets
    // requested by off-screen panels must not hold the whole story hostage.
    if (fonts?.status === 'loading' || states.includes('pending')) return { ready: false };
    const failedFont = fonts?.check && [...fontSpecs].some(spec => { try { return !fonts.check(spec); } catch { return false; } });
    return states.includes('error') || failedFont ? { ready: false, error: true } : { ready: true };
  }
  function check() {
    queued = false;
    if (stopped) return;
    const state = inspect();
    if (!state.ready) { publish(state); return; }
    if (last?.ready) return;
    const version = revision;
    frame1 = win.requestAnimationFrame(() => {
      frame2 = win.requestAnimationFrame(() => {
        if (stopped || revision !== version) return;
        publish(inspect());
      });
    });
  }
  function schedule() {
    if (stopped) return;
    ++revision;
    win.cancelAnimationFrame(frame1); win.cancelAnimationFrame(frame2);
    if (!queued) { queued = true; queueMicrotask(check); }
  }
  function downloading() { publish({ ready: false }); schedule(); }
  function blockInput(event: Event) {
    if (!last?.ready) { event.preventDefault(); event.stopImmediatePropagation(); }
  }
  const changes = new win.MutationObserver(records => {
    // Streaming prose/token counters do not change asset requirements. Font
    // loading events still cover newly needed glyphs; CSS edits need a rescan.
    if (records.some(record => record.type !== 'characterData' || record.target.parentElement?.tagName === 'STYLE')) schedule();
  });
  changes.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'srcset', 'sizes', 'style', 'class', 'poster'] });
  for (const type of ['load', 'error', 'loadeddata', 'canplay']) root.addEventListener(type, schedule, true);
  for (const type of ['keydown', 'pointerdown', 'click', 'wheel']) win.addEventListener(type, blockInput, { capture: true, passive: false });
  win.addEventListener(SANDBOX_ASSET_LOADING_EVENT, downloading);
  win.addEventListener(SANDBOX_ASSET_READY_EVENT, schedule);
  win.addEventListener('resize', schedule);
  doc.fonts?.addEventListener('loading', downloading);
  doc.fonts?.addEventListener('loadingdone', schedule);
  doc.fonts?.addEventListener('loadingerror', schedule);
  publish({ ready: false }); schedule();
  function stop() {
    if (stopped) return;
    stopped = true; changes.disconnect();
    win.cancelAnimationFrame(frame1); win.cancelAnimationFrame(frame2);
    for (const type of ['load', 'error', 'loadeddata', 'canplay']) root.removeEventListener(type, schedule, true);
    for (const type of ['keydown', 'pointerdown', 'click', 'wheel']) win.removeEventListener(type, blockInput, true);
    win.removeEventListener(SANDBOX_ASSET_LOADING_EVENT, downloading);
    win.removeEventListener(SANDBOX_ASSET_READY_EVENT, schedule);
    win.removeEventListener('resize', schedule);
    doc.fonts?.removeEventListener('loading', downloading);
    doc.fonts?.removeEventListener('loadingdone', schedule);
    doc.fonts?.removeEventListener('loadingerror', schedule);
    root.style.visibility = originalVisibility; root.inert = originalInert;
  }
  return stop;
}
