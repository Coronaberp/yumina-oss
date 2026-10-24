import type { YouTubePlayer } from "./youtube-playback";

export interface OfficialYouTubePlayer extends YouTubePlayer { destroy(): void }
export interface YouTubeEvent { target: OfficialYouTubePlayer; data?: number }
export interface YouTubeApi {
  Player: new (element: HTMLIFrameElement, options: { events: { onReady: (event: YouTubeEvent) => void; onStateChange: (event: YouTubeEvent) => void; onError: (event: YouTubeEvent) => void; onAutoplayBlocked: (event: YouTubeEvent) => void } }) => OfficialYouTubePlayer;
}
type YouTubeWindow = Window & { YT?: YouTubeApi; onYouTubeIframeAPIReady?: () => void };
let loading: Promise<YouTubeApi> | null = null;
/** Fixed official script only. No user URL, API key, search or login. */
export function loadYouTubeApi(): Promise<YouTubeApi> {
  const win = window as YouTubeWindow;
  if (win.YT?.Player) return Promise.resolve(win.YT);
  if (loading) return loading;
  loading = new Promise<YouTubeApi>((resolve, reject) => {
    const previous = win.onYouTubeIframeAPIReady;
    const script = document.createElement("script");
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(deadline);
      if (win.onYouTubeIframeAPIReady === ready) win.onYouTubeIframeAPIReady = previous;
      if (error) { script.remove(); loading = null; reject(error); }
      else if (win.YT?.Player) resolve(win.YT);
      else { script.remove(); loading = null; reject(new Error("YouTube player API unavailable")); }
    };
    const ready = () => { try { previous?.(); } finally { finish(); } };
    const deadline = setTimeout(() => finish(new Error("YouTube player connection timed out")), 15_000);
    win.onYouTubeIframeAPIReady = ready;
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.onerror = () => finish(new Error("YouTube player could not load"));
    document.head.appendChild(script);
  });
  return loading;
}
