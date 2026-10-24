import { validateMusicDecision, type MusicCatalogEntry, type MusicDecision } from "@yumina/shared";

export interface MusicPlayback {
  stop(): void;
  playBgm(id: string): void;
  playSfx(id: string, startSeconds: number, endSeconds: number): void;
  stopSfx(): void;
  pause(): void;
  resume(): void;
}
/** One decision per completed reply; no retries, model loop or dialogue writes. */
export class MusicDjController {
  status = "Ready";
  bgmId: string | null = null;
  private revision = 0;
  private scope = "";
  private catalog: MusicCatalogEntry[] = [];
  private seen = new Set<string>();
  private request?: AbortController;
  private paused = false;
  private locked = false;
  private skippedId: string | null = null;
  private changedAt = -Infinity;
  private cueUntil = 0;
  constructor(private playback: MusicPlayback, private decide: (reply: string, signal: AbortSignal) => Promise<MusicDecision>, private now = Date.now, private notify: () => void = () => {}) {}
  reset(scope: string, catalog: MusicCatalogEntry[]): void {
    this.cancel(); this.scope = scope; this.catalog = catalog; this.seen.clear();
    this.bgmId = null; this.skippedId = null; this.paused = false; this.locked = false;
    this.changedAt = -Infinity; this.cueUntil = 0; this.playback.stop();
  }
  cancel(): void { this.revision++; this.request?.abort(); this.request = undefined; }
  dispose(): void { this.cancel(); this.scope = ""; this.playback.stop(); }
  setLocked(locked: boolean): void { this.cancel(); this.locked = locked; this.status = locked ? "Music locked" : "Ready"; this.notify(); }
  pause(): void { this.cancel(); this.paused = true; this.cueUntil = 0; this.playback.stopSfx(); this.playback.pause(); this.status = "Music paused"; this.notify(); }
  /** External player/visibility controls already changed transport; cancel only
   * the DJ so native controls keep their authority. */
  hold(status: string): void { this.cancel(); this.paused = true; this.cueUntil = 0; this.status = status; this.notify(); }
  playManually(id: string): void {
    const item = this.catalog.find(entry => entry.id === id);
    if (!item) return;
    this.cancel(); this.paused = false;
    if (item.type === "bgm") {
      this.playback.playBgm(id); this.bgmId = id; this.skippedId = null; this.changedAt = this.now();
    } else if (item.startSeconds !== undefined && item.endSeconds !== undefined) {
      this.playback.playSfx(id, item.startSeconds, item.endSeconds);
      this.cueUntil = this.now() + (item.endSeconds - item.startSeconds) * 1000 + 3000;
    }
    this.status = this.locked ? "Music locked" : "Ready"; this.notify();
  }
  resume(): void { this.cancel(); this.paused = false; this.playback.resume(); this.status = this.locked ? "Music locked" : "Ready"; this.notify(); }
  skip(): void { this.cancel(); this.skippedId = this.bgmId; this.bgmId = null; this.cueUntil = 0; this.playback.stop(); this.status = "Track skipped"; this.notify(); }
  async observe(reply: { id: string; content: string }): Promise<void> {
    if (!this.scope || this.paused || this.locked || !reply.content || this.catalog.length === 0) return;
    // Hash the complete content, including edits/regenerations with the same id.
    let hash = 2166136261;
    for (let i = 0; i < reply.content.length; i++) hash = Math.imul(hash ^ reply.content.charCodeAt(i), 16777619);
    const key = `${reply.id}:${reply.content.length}:${hash}`;
    if (this.seen.has(key)) return;
    this.seen.add(key); if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
    this.cancel(); const revision = this.revision; const request = new AbortController(); this.request = request;
    const deadline = setTimeout(() => request.abort(), 20_000);
    this.status = "Choosing music…"; this.notify();
    try {
      const raw = await this.decide(reply.content, request.signal);
      if (request.signal.aborted || revision !== this.revision || this.paused || this.locked) return;
      const decision = validateMusicDecision(raw, this.catalog);
      const now = this.now();
      if (decision.bgm.action === "play" && decision.bgm.trackId !== this.bgmId && decision.bgm.trackId !== this.skippedId) {
        const elapsed = now - this.changedAt;
        if (elapsed >= 30_000 || (decision.bgm.majorSceneChange && elapsed >= 5_000)) {
          this.playback.playBgm(decision.bgm.trackId); this.bgmId = decision.bgm.trackId; this.changedAt = now; this.skippedId = null;
        }
      } else if (decision.bgm.action === "stop" && this.bgmId && now - this.changedAt >= 30_000) {
        this.playback.stop(); this.bgmId = null; this.cueUntil = 0; this.changedAt = now;
      }
      if (decision.sfx && now >= this.cueUntil) {
        this.playback.playSfx(decision.sfx.trackId, decision.sfx.startSeconds, decision.sfx.endSeconds);
        this.cueUntil = now + (decision.sfx.endSeconds - decision.sfx.startSeconds) * 1000 + 3000;
      }
      this.status = "Ready";
    } catch {
      if (revision === this.revision) this.status = "Music decision unavailable; story continues.";
    } finally {
      clearTimeout(deadline);
      if (revision === this.revision) { if (request.signal.aborted) this.status = "Music decision timed out; story continues."; this.request = undefined; this.notify(); }
    }
  }
}
