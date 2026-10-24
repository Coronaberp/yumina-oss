import { useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "@/stores/chat";
import { useConfigStore } from "@/stores/config";
import { useAudioStore, type BGMEvalContext } from "@/stores/audio";
import type { AudioTrack } from "@yumina/engine";
import type { MusicAudioMode } from "@yumina/shared";
import { MusicDjController } from "./controller";
import { DEFAULT_MUSIC_DJ, useMusicDjPreferences } from "./preferences";
import { requestMusicDecision } from "./request";
import { sessionAudioSource, youtubeSource } from "./source";

// Cached renderers can unmount after a new session has acquired playback.
// A lease makes their cleanup harmless to the current listener.
let activeLease: symbol | null = null;
const EMPTY_TRACKS: AudioTrack[] = [];
export function useMusicDj(accountId: string, sessionId: string, active: boolean) {
  const preferences = useMusicDjPreferences(s => s.accounts[accountId] ?? DEFAULT_MUSIC_DJ);
  const mode = useMusicDjPreferences(s => s.modes[`${accountId}:${sessionId}`] ?? "creator");
  const setModePreference = useMusicDjPreferences(s => s.setMode);
  const session = useChatStore(s => s.session);
  const messages = useChatStore(s => s.messages);
  const streaming = useChatStore(s => s.isStreaming);
  const readOnly = useChatStore(s => s.readOnly);
  const selectedModel = useConfigStore(s => s.selectedModel);
  const rawTracks = (session?.world?.schema as { audioTracks?: AudioTrack[] } | undefined)?.audioTracks ?? EMPTY_TRACKS;
  const source = useMemo(() => sessionAudioSource(rawTracks), [rawTracks]);
  const [status, setStatus] = useState("Creator audio");
  const [paused, setPaused] = useState(false);
  const [locked, setLocked] = useState(false);
  const controller = useRef<MusicDjController | null>(null);
  const validSession = active && !readOnly && session?.id === sessionId && !!accountId;
  const ready = validSession && mode === "personal" && preferences.consent && preferences.source === "session" && source.catalog.length > 0;

  useEffect(() => {
    if (!validSession) return;
    const lease = Symbol(sessionId); activeLease = lease;
    const owns = () => activeLease === lease;
    const audio = () => useAudioStore.getState();
    audio().setMusicAudioMode(mode);
    audio().setPersonalTracks(source.tracks);
    if (mode === "creator" && audio().activeTracks.size === 0) {
      const state = useChatStore.getState();
      audio().evaluateConditionalBGM({ worldId: session?.worldId ?? "", variables: state.gameState as BGMEvalContext["variables"], turnCount: state.messages.filter(m => m.role === "assistant").length, metadata: {} });
      if (audio().playlist?.autoPlay && !audio().playlist?.waitForFirstMessage && audio().activeTracks.size === 0) audio().startPlaylist();
    }
    let bgm: string | null = null, cue: string | null = null;
    const stopCue = () => { if (owns() && cue) audio().stopPersonalTrack(cue); cue = null; };
    const stop = () => { if (owns() && bgm) audio().stopPersonalTrack(bgm); bgm = null; stopCue(); };
    const dj: MusicDjController = new MusicDjController({
      stop, stopSfx: stopCue,
      playBgm: id => {
        if (!owns()) return;
        if (bgm) audio().stopPersonalTrack(bgm);
        bgm = id;
        const declared = source.tracks.find(t => t.id === id)?.maxDuration;
        audio().playPersonalTrack(id, { loop: true, fadeDuration: 0, maxDuration: Math.min(preferences.maxBgmSeconds, declared && declared > 0 ? declared : preferences.maxBgmSeconds) });
      },
      playSfx: (id, startSeconds, endSeconds) => {
        if (!owns()) return;
        stopCue(); cue = id;
        audio().playPersonalTrack(id, { loop: false, fadeDuration: 0, duckBgm: true, startSeconds, endSeconds, maxDuration: endSeconds - startSeconds });
      },
      pause: () => { if (owns() && bgm) audio().pausePersonalTrack(bgm); },
      resume: () => { if (owns() && bgm) audio().resumePersonalTrack(bgm); },
    }, (reply, signal) => requestMusicDecision(sessionId, reply, source.catalog, preferences, selectedModel, dj.bgmId, signal), Date.now, () => { if (owns()) setStatus(dj.status); });
    dj.reset(sessionId, source.catalog); controller.current = dj;
    setPaused(false); setLocked(false);
    setStatus(mode === "off" ? "Audio off" : mode === "creator" ? "Creator audio" : !preferences.consent ? "Enable Personal Music DJ in Personal Settings first." : preferences.source === "youtube" ? youtubeSource.reason : preferences.source !== "session" ? "Choose a music source in Personal Settings." : !source.catalog.length ? "No supported uploaded audio in this session." : "Ready");
    return () => {
      dj.dispose();
      if (controller.current === dj) controller.current = null;
      if (owns()) { audio().setMusicAudioMode("creator"); activeLease = null; }
    };
  }, [validSession, accountId, sessionId, mode, preferences, source, selectedModel]);

  useEffect(() => {
    const dj = controller.current;
    if (!dj || !ready) return;
    if (streaming) { dj.cancel(); return; }
    const last = [...messages].reverse().find(m => m.role === "assistant" && !m.id.startsWith("pending-"));
    if (last) void dj.observe({ id: last.id, content: last.content });
  }, [messages, streaming, ready, mode, preferences, source, selectedModel, sessionId]);

  return {
    mode: validSession ? mode : "creator" as MusicAudioMode, status, paused, locked,
    setMode: (next: unknown) => { if (validSession && ["creator", "personal", "off"].includes(next as string)) setModePreference(accountId, sessionId, next as MusicAudioMode); },
    command: (command: unknown) => {
      if (!validSession || mode !== "personal") return;
      const dj = controller.current; if (!dj) return;
      if (command === "pause") { dj.pause(); setPaused(true); }
      if (command === "resume") { dj.resume(); setPaused(false); }
      if (command === "skip") dj.skip();
      if (command === "lock") { dj.setLocked(!locked); setLocked(!locked); }
    },
  };
}
