import { sanitizeYouTubeItems, type YouTubeMusicItem } from "./youtube-catalog";
import type { MusicPlayback } from "./controller";

/** Only documented IFrame methods; there is no media URL, download or search. */
export interface YouTubePlayer {
  loadVideoById(value: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData(): { video_id?: string };
  setVolume(value: number): void;
}
export interface YouTubePlaybackView {
  ready: boolean; visible: boolean; needsGesture: boolean;
  currentId: string | null; kind: "bgm" | "sfx" | null; message: string;
}
interface Background {
  item: YouTubeMusicItem; position: number; expiresAt: number; epoch: number;
}
interface Current {
  item: YouTubeMusicItem; armed: boolean;
  resumeEpoch?: number;
}
/** Serial transport adapter, not another general audio engine. The existing DJ
 * still owns decisions/dwell/manual overrides; one official player owns video. */
export class YouTubeMusicPlayback implements MusicPlayback {
  private items: Map<string, YouTubeMusicItem>;
  private player: YouTubePlayer | null = null;
  private background: Background | null = null;
  private current: Current | null = null;
  private serial = 0;
  private visible = false;
  private manualPaused = false;
  private needsGesture = false;
  private disposed = false;
  private bgmVolume = .49;
  private sfxVolume = .56;
  private message = "Loading the visible YouTube player…";
  constructor(items: YouTubeMusicItem[], private maximumBgmSeconds: number, private notify: () => void, private interrupted: (reason: string) => void, private now = Date.now) {
    this.items = new Map(sanitizeYouTubeItems(items).map(item => [item.id, item]));
  }
  get view(): YouTubePlaybackView {
    return { ready: !!this.player && !this.disposed, visible: this.visible, needsGesture: this.needsGesture,
      currentId: this.current?.item.id ?? this.background?.item.id ?? null,
      kind: this.current?.item.type ?? (this.background ? "bgm" : null), message: this.message };
  }
  private emit(message?: string): void { if (message) this.message = message; this.notify(); }
  attach(player: YouTubePlayer): void {
    if (this.disposed) return;
    this.player = player;
    this.applyVolume();
    this.emit("YouTube player ready");
    this.startQueuedBackground();
  }
  detach(player: YouTubePlayer): void {
    if (this.player !== player) return;
    this.pause(); this.player = null; this.current = null;
    this.emit("Player closed; press Show player to reconnect.");
  }
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      this.pause(); this.needsGesture = true;
      this.emit("Player hidden; show it and press Play / resume.");
      this.interrupted(this.message);
    } else {
      this.emit(this.manualPaused ? "Player visible; press Play / resume." : "YouTube player ready");
      this.startQueuedBackground();
    }
  }
  setVolumes(bgm: number, sfx: number): void {
    this.bgmVolume = Math.max(0, Math.min(1, Number.isFinite(bgm) ? bgm : 0));
    this.sfxVolume = Math.max(0, Math.min(1, Number.isFinite(sfx) ? sfx : 0));
    this.applyVolume();
  }
  private applyVolume(): void {
    try { this.player?.setVolume(Math.round(100 * (this.current?.item.type === "sfx" ? this.sfxVolume : this.bgmVolume))); } catch { /* player may be connecting */ }
  }
  private snapshotMatches(player: YouTubePlayer, state?: number): boolean {
    if (this.disposed || player !== this.player || !this.current) return false;
    try {
      return player.getVideoData().video_id === this.current.item.videoId && (state === undefined || player.getPlayerState() === state);
    } catch { return false; }
  }
  private rememberBackground(): void {
    if (!this.background || this.current?.item.type !== "bgm" || !this.current.armed || !this.player || !this.snapshotMatches(this.player)) return;
    const position = this.player.getCurrentTime();
    if (Number.isFinite(position) && position >= 0) this.background.position = position;
  }
  private startQueuedBackground(): void {
    if (this.background && !this.current && !this.manualPaused && this.visible && this.player) this.loadBackground();
  }
  private load(item: YouTubeMusicItem, start: number, resumeEpoch?: number): void {
    if (!this.player || !this.visible || this.manualPaused || this.disposed) return;
    this.serial++;
    this.current = { item, armed: false, resumeEpoch };
    this.needsGesture = false;
    this.applyVolume();
    this.emit(item.type === "sfx" ? `Loading cue: ${item.name}` : `Loading BGM: ${item.name}`);
    try {
      this.player.loadVideoById({ videoId: item.videoId, startSeconds: start,
        ...(item.endSeconds !== undefined ? { endSeconds: item.endSeconds } : {}) });
    } catch { this.fail("The YouTube player is unavailable."); }
  }
  private loadBackground(): void {
    const bgm = this.background;
    if (!bgm) return;
    if (this.now() >= bgm.expiresAt) { this.stop(); this.emit("BGM time limit reached. Choose a track to play again."); return; }
    let position = bgm.position;
    if (position < (bgm.item.startSeconds ?? 0) || (bgm.item.endSeconds !== undefined && position >= bgm.item.endSeconds)) position = bgm.item.startSeconds ?? 0;
    this.load(bgm.item, position);
  }
  playBgm(id: string): void {
    if (this.disposed) return;
    const item = this.items.get(id);
    if (!item || item.type !== "bgm") return;
    if (this.background?.item.id === id && this.now() < this.background.expiresAt) {
      if (this.current?.item.type === "sfx") { this.stopSfx(); this.loadBackground(); }
      else if (!this.current) this.startQueuedBackground();
      else if (!this.manualPaused && this.visible && this.player?.getPlayerState() === 2) this.resume();
      return;
    }
    this.background = { item, position: item.startSeconds ?? 0, expiresAt: this.now() + Math.max(60, Math.min(900, this.maximumBgmSeconds)) * 1000, epoch: ++this.serial };
    this.current = null;
    this.startQueuedBackground();
  }
  playSfx(id: string, startSeconds: number, endSeconds: number): void {
    const item = this.items.get(id);
    if (this.disposed || !item || item.type !== "sfx" || item.startSeconds !== startSeconds || item.endSeconds !== endSeconds || this.manualPaused || !this.visible || !this.player || this.current?.item.type === "sfx") return;
    this.rememberBackground();
    this.load(item, startSeconds, this.background?.epoch);
  }
  stopSfx(): void {
    if (this.current?.item.type !== "sfx") return;
    this.current = null; this.serial++;
    if (this.background) this.background.epoch = this.serial;
    try { this.player?.pauseVideo(); } catch { /* cancellation is still final */ }
  }
  pause(): void {
    this.rememberBackground(); this.stopSfx(); this.manualPaused = true; this.serial++;
    if (this.background) this.background.epoch = this.serial;
    try { this.player?.pauseVideo(); } catch { /* no restoration after manual pause */ }
    this.emit("Music paused");
  }
  /** A direct user gesture may authorize a new selection without resuming an old cue. */
  allowManualPlayback(): boolean {
    if (!this.visible || !this.player || this.disposed) { this.emit("Show the player before playing."); return false; }
    this.manualPaused = false; this.needsGesture = false; return true;
  }
  resume(): void {
    if (!this.allowManualPlayback()) return;
    if (!this.background) { this.emit("Choose a saved BGM or cue below."); return; }
    if (this.now() >= this.background.expiresAt) { this.stop(); this.emit("BGM time limit reached. Choose a track to play again."); return; }
    if (this.current?.item.type === "bgm" && this.snapshotMatches(this.player!)) {
      try { if (this.player!.getPlayerState() !== 1) this.player!.playVideo(); this.emit(`Playing BGM: ${this.current.item.name}`); }
      catch { this.fail("The YouTube player is unavailable."); }
    } else this.loadBackground();
  }
  stop(): void {
    this.serial++; this.background = null; this.current = null; this.needsGesture = false;
    try { this.player?.stopVideo(); } catch { /* late events have no active intent */ }
    this.emit("No music selected");
  }
  private finishCue(failure?: string): void {
    const cue = this.current;
    if (!cue || cue.item.type !== "sfx") return;
    this.current = null;
    const returning = !!(this.background && cue.resumeEpoch === this.background.epoch && !this.manualPaused && this.visible && !this.disposed);
    if (returning) this.loadBackground();
    else { try { this.player?.pauseVideo(); } catch { /* The official frame may already be closed. */ } this.emit("Cue finished"); }
    if (failure) this.emit(failure + (returning ? " Returning to BGM." : ""));
  }
  private fail(message: string): void {
    if (this.current?.item.type === "sfx") { this.finishCue(message); return; }
    this.current = null; this.manualPaused = true; this.needsGesture = true; this.serial++;
    try { this.player?.pauseVideo(); } catch { /* The official frame may already be closed. */ }
    this.emit(message); this.interrupted(message);
  }
  onError(code: number, player: YouTubePlayer): void {
    if (this.disposed || player !== this.player || !this.current) return;
    let id = "";
    try { id = player.getVideoData().video_id ?? ""; } catch { /* The official frame may already be closed. */ }
    if (id && id !== this.current.item.videoId) return;
    // An old error delivered after a replacement has demonstrably begun playing
    // must not stop that successful replacement.
    if (this.current.armed && player.getPlayerState() === 1) return;
    this.fail(`YouTube video unavailable (${code}). Choose another saved video or try Play / resume.`);
  }
  onAutoplayBlocked(player: YouTubePlayer): void {
    if (this.disposed || player !== this.player || !this.current) return;
    this.pause(); this.needsGesture = true;
    this.emit("Autoplay was blocked. Press Play / resume, or choose a saved video and press Play selection.");
    this.interrupted(this.message);
  }
  onState(state: number, player: YouTubePlayer): void {
    if (this.disposed || player !== this.player) return;
    if (!this.visible && state === 1 && player.getPlayerState() === 1) {
      try { player.pauseVideo(); } catch { /* The official frame may already be closed. */ } return;
    }
    if (!this.current && state === 1 && player.getPlayerState() === 1 && this.visible && !this.manualPaused) {
      this.manualPaused = true;
      this.emit("YouTube controls are active; DJ paused. Use Play selection to choose a saved track.");
      this.interrupted(this.message); return;
    }
    if (!this.snapshotMatches(player, state)) {
      if (this.current?.armed && state === 1 && player.getPlayerState() === 1 && player.getVideoData().video_id !== this.current.item.videoId) {
        this.current = null; this.background = null; this.manualPaused = true; this.serial++;
        this.emit("The video changed in YouTube; automatic return is cancelled. DJ paused.");
        this.interrupted(this.message);
      }
      return;
    }
    const current = this.current!;
    const duration = player.getDuration();
    if (current.item.type === "bgm" && duration > 0 && duration < 5) { this.fail("This BGM is too short to repeat. Choose a video or range of at least five seconds."); return; }
    if (duration > 0 && current.item.endSeconds !== undefined && ((current.item.startSeconds ?? 0) >= duration || current.item.endSeconds > duration + .5)) {
      this.fail("The saved range is outside this video. Check its start and end in Personal Settings."); return;
    }
    if (!this.visible) { try { player.pauseVideo(); } catch { /* The official frame may already be closed. */ } return; }
    if (state === 1) {
      const time = player.getCurrentTime();
      if (current.item.type === "sfx" && (time < current.item.startSeconds! - 10 || time > current.item.endSeconds! + 1)) return;
      current.armed = true; this.needsGesture = false;
      this.emit(`${this.manualPaused ? "Playing with DJ paused" : current.item.type === "sfx" ? "Playing cue" : "Playing BGM"}: ${current.item.name}`);
    } else if (state === 3) this.emit(`Buffering: ${current.item.name}`);
    else if (state === 2 && current.armed && !this.manualPaused) {
      this.pause(); this.interrupted("Paused in the YouTube player; press Play / resume to continue the DJ.");
    } else if (state === 0 && current.armed && !this.manualPaused) {
      if (current.item.type === "sfx") {
        const duration = player.getDuration();
        if (player.getCurrentTime() + .5 < Math.min(current.item.endSeconds!, duration > 0 ? duration : current.item.endSeconds!)) return;
        this.finishCue();
      } else if (this.background) {
        this.background.position = this.background.item.startSeconds ?? 0;
        this.current = null; this.loadBackground();
      }
    }
  }
  /** Content boundaries are delegated to the official endSeconds parameter.
   * Never use an ad detector or a cue wall-clock timer to force a transition. */
  tick(): void {
    if (this.disposed) return;
    if (this.background && this.now() >= this.background.expiresAt) {
      this.background = null;
      if (this.current?.item.type === "bgm") { this.stop(); this.emit("BGM time limit reached. Choose a track to play again."); return; }
    }
    if (!this.player || !this.current?.armed || this.manualPaused || !this.visible || !this.snapshotMatches(this.player)) return;
    const end = this.current.item.endSeconds;
    // Seeking in the native player can invalidate endSeconds. Relinquish the
    // cue's automatic return instead of fighting native controls or skipping ads.
    if (end !== undefined && this.player.getCurrentTime() > end + 1 && this.player.getPlayerState() === 1) {
      this.current = null; this.manualPaused = true; this.serial++;
      if (this.background) this.background.epoch = this.serial;
      this.emit("The range changed in the YouTube player; automatic return is cancelled. DJ paused.");
      this.interrupted(this.message);
    }
  }

  connectionFailed(): void { this.manualPaused = true; this.needsGesture = true; this.emit("Could not load YouTube. Check the connection and press Reconnect player."); this.interrupted(this.message); }
  dispose(): void {
    this.stop(); this.disposed = true; this.player = null; this.visible = false; this.emit("Player closed");
  }
}
