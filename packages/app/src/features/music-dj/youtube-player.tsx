import { useEffect, useRef, useState } from "react";
import { loadYouTubeApi, type OfficialYouTubePlayer } from "./youtube-api";
import type { YouTubeMusicItem } from "./youtube-catalog";
import type { YouTubeMusicPlayback, YouTubePlaybackView } from "./youtube-playback";

// Cached session renderers must never keep two official players alive.
let installed: { player: OfficialYouTubePlayer; owner: symbol } | null = null;
interface Props {
  playback: YouTubeMusicPlayback;
  suspended?: boolean;
  view: YouTubePlaybackView;
  items: YouTubeMusicItem[];
  onPause: () => void;
  onResume: () => void;
  onSkip: () => void;
  onSelection: (id: string) => void;
}
export function YouTubeMusicPlayer({ playback, view, items, onPause, onResume, onSkip, onSelection, suspended = false }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState(items.find(item => item.type === "bgm")?.id ?? items[0]?.id ?? "");
  const selection = items.some(item => item.id === selected) ? selected : items.find(item => item.type === "bgm")?.id ?? items[0]?.id ?? "";

  useEffect(() => {
    if (!expanded || suspended || !mount.current || !items.length) return;
    const container = mount.current;
    const owner = Symbol("visible-youtube-player");
    let cancelled = false;
    let player: OfficialYouTubePlayer | null = null;
    let fraction = 0;
    const updateVisibility = () => {
      const fullscreen = document.fullscreenElement;
      const playerFullscreen = !!fullscreen && container.contains(fullscreen);
      const rect = (playerFullscreen ? fullscreen : container).getBoundingClientRect();
      const points = [[.5,.5],[.25,.25],[.75,.25],[.25,.75],[.75,.75]];
      const uncovered = points.filter(([x,y]) => {
        const top = document.elementFromPoint(rect.left + rect.width * x!, rect.top + rect.height * y!);
        return !!top && (top === container || container.contains(top));
      }).length;
      playback.setVisible(document.visibilityState === "visible" && (playerFullscreen || fraction > .5) && rect.width >= 200 && rect.height >= 200 && uncovered >= 3);
    };
    const observer = new IntersectionObserver(entries => { fraction = entries[0]?.intersectionRatio ?? 0; updateVisibility(); }, { threshold: [0, .5, .51, 1] });
    observer.observe(container);
    document.addEventListener("visibilitychange", updateVisibility);
    document.addEventListener("fullscreenchange", updateVisibility);
    window.addEventListener("resize", updateVisibility);
    const interval = setInterval(() => { updateVisibility(); playback.tick(); }, 250);
    void loadYouTubeApi().then(api => {
      if (cancelled) return;
      if (installed) { try { installed.player.stopVideo(); installed.player.destroy(); } catch { /* A replaced official frame may already be detached. */ } installed = null; }
      const iframe = document.createElement("iframe");
      iframe.title = "Personal Music DJ YouTube player";
      iframe.referrerPolicy = "strict-origin-when-cross-origin";
      iframe.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
      iframe.allowFullscreen = true;
      iframe.style.cssText = "display:block;width:100%;height:100%;border:0;min-width:200px;min-height:200px";
      const query = new URLSearchParams({ enablejsapi: "1", origin: window.location.origin, playsinline: "1", controls: "1", autoplay: "0" });
      iframe.src = `https://www.youtube.com/embed/${items[0]!.videoId}?${query}`;
      container.replaceChildren(iframe);
      player = new api.Player(iframe, { events: {
        onReady: event => { if (!cancelled && installed?.owner === owner) { playback.attach(event.target); updateVisibility(); } },
        onStateChange: event => { if (!cancelled && installed?.owner === owner) playback.onState(event.data ?? -1, event.target); },
        onError: event => { if (!cancelled && installed?.owner === owner) playback.onError(event.data ?? 0, event.target); },
        onAutoplayBlocked: event => { if (!cancelled && installed?.owner === owner) playback.onAutoplayBlocked(event.target); },
      } });
      installed = { player, owner };
    }).catch(() => { if (!cancelled) playback.connectionFailed(); });
    return () => {
      cancelled = true; clearInterval(interval); observer.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
      document.removeEventListener("fullscreenchange", updateVisibility);
      window.removeEventListener("resize", updateVisibility);
      playback.setVisible(false);
      if (player) { playback.detach(player); try { player.destroy(); } catch { /* A replaced official frame may already be detached. */ } }
      if (installed?.owner === owner) installed = null;
      container.replaceChildren();
    };
  }, [playback, expanded, attempt, items, suspended]);

  const button = "rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-50";
  return <aside aria-label="Personal YouTube music" className="music-dj-youtube-panel shrink-0 rounded-xl border border-border bg-card text-foreground shadow-xl" data-expanded={expanded} style={{ width: expanded ? "min(480px, 100%)" : "auto", maxHeight: "100%", overflowY: "auto" }}>
    {expanded ? <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"><span className="text-sm font-medium">My YouTube music</span><button type="button" className={button} onClick={() => { playback.setVisible(false); setExpanded(false); }}>Hide player &amp; pause</button></div>
      {/* Never put overlays, labels, replacement controls or loaders over this viewport. */}
      <div ref={mount} data-youtube-viewport="true" style={{ width: "100%", aspectRatio: "16 / 9", minWidth: 200, minHeight: 200, background: "#000" }} />
      <div className="space-y-2 p-3">
        <p role="status" className="break-words text-xs text-muted-foreground">{view.message}</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!view.ready || !view.visible} onClick={onResume}>Play / resume</button><button type="button" className={button} onClick={onPause}>Pause</button><button type="button" className={button} onClick={onSkip}>Skip</button>{!view.ready && <button type="button" className={button} onClick={() => setAttempt(value => value + 1)}>Reconnect player</button>}</div>
        <div className="flex items-center gap-2"><select aria-label="Saved YouTube video" className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs" value={selection} onChange={e => setSelected(e.target.value)}>{items.map(item => <option key={item.id} value={item.id}>{item.type === "sfx" ? "Cue: " : "BGM: "}{item.name}</option>)}</select><button type="button" className={button} disabled={!selection || !view.ready || !view.visible} onClick={() => onSelection(selection)}>Play selection</button></div>
        <p className="text-xs text-muted-foreground">Cues interrupt BGM. Timing and returns are approximate; buffering, ads and autoplay rules may interrupt playback. Seeking may cancel a cue’s automatic return. Uploaded audio keeps 60% ducking.</p>
      </div>
    </> : <button type="button" className="px-3 py-2 text-sm" onClick={() => setExpanded(true)}>Show YouTube player</button>}
  </aside>;
}
