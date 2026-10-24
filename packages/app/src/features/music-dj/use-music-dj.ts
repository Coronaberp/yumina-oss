import { useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "@/stores/chat";
import { useConfigStore } from "@/stores/config";
import { useAudioStore, type BGMEvalContext } from "@/stores/audio";
import type { AudioTrack } from "@yumina/engine";
import type { MusicAudioMode } from "@yumina/shared";
import { MusicDjController, type MusicPlayback } from "./controller";
import { DEFAULT_MUSIC_DJ, useMusicDjPreferences } from "./preferences";
import { requestMusicDecision } from "./request";
import { sessionAudioSource } from "./source";
import { sanitizeYouTubeItems, youtubeCatalog, type YouTubeMusicItem } from "./youtube-catalog";
import { YouTubeMusicPlayback, type YouTubePlaybackView } from "./youtube-playback";

let activeLease: symbol | null = null;
const EMPTY_TRACKS: AudioTrack[] = [];
const EMPTY_YOUTUBE: YouTubeMusicItem[] = [];
export function useMusicDj(accountId: string, sessionId: string, active: boolean) {
  const preferences = useMusicDjPreferences(s => s.accounts[accountId] ?? DEFAULT_MUSIC_DJ);
  const mode = useMusicDjPreferences(s => s.modes[`${accountId}:${sessionId}`] ?? "creator");
  const setModePreference = useMusicDjPreferences(s => s.setMode);
  const session = useChatStore(s => s.session);
  const messages = useChatStore(s => s.messages);
  const streaming = useChatStore(s => s.isStreaming);
  const readOnly = useChatStore(s => s.readOnly);
  const selectedModel = useConfigStore(s => s.selectedModel);
  const audioEnabled = useAudioStore(s => s.worldAudioEnabled);
  const bgmGain = useAudioStore(s => s.bgmVolume * s.masterVolume * (s.muted ? 0 : 1));
  const sfxGain = useAudioStore(s => s.sfxVolume * s.masterVolume * (s.muted ? 0 : 1));
  const rawTracks = (session?.world?.schema as { audioTracks?: AudioTrack[] } | undefined)?.audioTracks ?? EMPTY_TRACKS;
  const source = useMemo(() => sessionAudioSource(rawTracks), [rawTracks]);
  const savedItems = preferences.youtubeCatalog ?? EMPTY_YOUTUBE;
  const youtubeItems = useMemo(() => sanitizeYouTubeItems(savedItems), [savedItems]);
  const catalog = useMemo(() => preferences.source === "youtube" ? youtubeCatalog(youtubeItems) : source.catalog, [preferences.source, youtubeItems, source]);
  const [status, setStatus] = useState("Creator audio");
  const [paused, setPaused] = useState(false);
  const [locked, setLocked] = useState(false);
  const [youtube, setYoutube] = useState<YouTubeMusicPlayback | null>(null);
  const [youtubeView, setYoutubeView] = useState<YouTubePlaybackView | null>(null);
  const controller = useRef<MusicDjController | null>(null);
  const validSession = active && !readOnly && session?.id === sessionId && !!accountId;
  const youtubeEnabled = validSession && audioEnabled && mode === "personal" && preferences.consent && preferences.source === "youtube" && preferences.youtubeConsent === true && youtubeItems.length > 0;
  const sourceReady = preferences.source === "session" || (youtubeEnabled && youtubeView?.ready && youtubeView.visible);
  const ready = validSession && audioEnabled && mode === "personal" && preferences.consent && sourceReady && catalog.length > 0;

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
    let video: YouTubeMusicPlayback | null = null;
    if (youtubeEnabled) {
      video = new YouTubeMusicPlayback(youtubeItems, preferences.maxBgmSeconds, () => { if (owns()) setYoutubeView(video!.view); }, reason => {
        if (!owns()) return;
        dj?.hold(reason); setPaused(true);
      });
      const state = audio();
      video.setVolumes(state.bgmVolume * state.masterVolume * (state.muted ? 0 : 1), state.sfxVolume * state.masterVolume * (state.muted ? 0 : 1));
    }
    const playback: MusicPlayback = video ?? {
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
    };
    const dj: MusicDjController = new MusicDjController(playback, (reply, signal) => requestMusicDecision(sessionId, reply, catalog, preferences, selectedModel, dj.bgmId, signal), Date.now, () => { if (owns()) setStatus(dj.status); });
    dj.reset(sessionId, catalog); controller.current = dj;
    // Publish the external runtime after setup; a disposed lease cannot publish
    // late state into a newly active session.
    queueMicrotask(() => {
      if (!owns()) return;
      setYoutube(video); setYoutubeView(video?.view ?? null);
      setPaused(false); setLocked(false);
      setStatus(dj.status === "Ready" ? (mode === "off" ? "Audio off" : mode === "creator" ? "Creator audio" : !audioEnabled ? "World audio is disabled in Personal Settings." : !preferences.consent ? "Enable Personal Music DJ in Personal Settings first." : preferences.source === "youtube" && !preferences.youtubeConsent ? "Enable the YouTube player disclosure in Personal Settings first." : preferences.source === "unconfigured" ? "Choose a music source in Personal Settings." : !catalog.length ? preferences.source === "youtube" ? "Add personal saved YouTube links in Personal Settings." : "No supported uploaded audio in this session." : "Ready") : dj.status);
    });
    return () => {
      dj.dispose(); video?.dispose();
      if (controller.current === dj) controller.current = null;
      if (owns()) { audio().setMusicAudioMode("creator"); activeLease = null; }
    };
  }, [validSession, accountId, sessionId, mode, preferences, source, catalog, youtubeItems, youtubeEnabled, audioEnabled, selectedModel, session?.worldId]);

  useEffect(() => { youtube?.setVolumes(bgmGain, sfxGain); }, [youtube, bgmGain, sfxGain]);
  useEffect(() => {
    const dj = controller.current;
    if (!dj || !ready) return;
    if (streaming) { dj.cancel(); return; }
    const last = [...messages].reverse().find(m => m.role === "assistant" && !m.id.startsWith("pending-"));
    if (last) void dj.observe({ id: last.id, content: last.content });
  }, [messages, streaming, ready, mode, preferences, source, catalog, selectedModel, sessionId]);

  return {
    mode: validSession ? mode : "creator" as MusicAudioMode,
    status: youtube && youtubeView && status === "Ready" ? youtubeView.message : status, paused, locked,
    youtubePlayer: youtubeEnabled && youtube ? { playback: youtube, view: youtubeView ?? youtube.view, items: youtubeItems } : null,
    setMode: (next: unknown) => { if (validSession && ["creator", "personal", "off"].includes(next as string)) setModePreference(accountId, sessionId, next as MusicAudioMode); },
    playSelection: (id: string) => {
      if (!validSession || !youtubeEnabled || !youtube?.allowManualPlayback()) return;
      controller.current?.playManually(id); setPaused(false);
    },
    command: (command: unknown) => {
      if (!validSession || mode !== "personal") return;
      const dj = controller.current; if (!dj) return;
      if (command === "pause") { dj.pause(); setPaused(true); }
      if (command === "resume") { if (youtube && !youtube.allowManualPlayback()) return; dj.resume(); setPaused(false); }
      if (command === "skip") dj.skip();
      if (command === "lock") { dj.setLocked(!locked); setLocked(!locked); }
    },
  };
}
