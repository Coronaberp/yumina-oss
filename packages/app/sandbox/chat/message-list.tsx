import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { useYumina } from "../sandbox-context";
import { MessageBubble } from "./message-bubble";
import { MessageActions } from "./message-actions";
import { SwipeControls } from "./swipe-controls";
import { makeChatT } from "./i18n";
import {
  EARLIER_HISTORY_TOP_PX,
  executeEarlierHistoryAction,
  getEarlierHistoryAction,
  shouldAutoRequestEarlierHistory,
} from "./message-history-pagination";
import type { SandboxMessage } from "./types";
import { anchorInitialTranscript, markTranscriptScroll, isInitialTranscriptScroll } from "./initial-message-scroll";
import { trackTranscriptPosition } from "./transcript-position";
import { restoreTranscriptHistory } from "./restore-transcript-history";
import { isScrollIntent } from "./scroll-intent";

import { chatHistoryRange, chatHistoryAround, selectChatHistory, shiftChatHistory, jumpChatHistory, MAX_CHAT_ROWS, type ChatHistoryWindow, type ChatHistoryEdge } from "./chat-history-window";

// The sandbox scroll guard (component-host.tsx) patches Element.prototype's
// scrollTop setter to NO-OP programmatic scrolls once the user has scrolled a
// container — right for creator auto-scroll-to-bottom, but it also swallows our
// own "reveal older messages" anchor below (reaching the toggle requires
// scrolling up, so the container is always user-scrolled by then). Capture the
// NATIVE setter at module load — which runs before the guard installs (the
// guard installs in a post-render effect) — so the anchor can compensate for
// content inserted above even after the user scrolled.
const NATIVE_SCROLLTOP_SET =
  Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")?.set ??
  Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop")?.set;

function setScrollTopRaw(el: HTMLElement, top: number): void {
  markTranscriptScroll(el);
  if (NATIVE_SCROLLTOP_SET) NATIVE_SCROLLTOP_SET.call(el, top);
  else el.scrollTop = top;
}

/** Find the element that actually owns vertical scrolling for the history
 *  marker. Creator layouts can put <Chat/> inside their own fixed-height
 *  overflow container, so the injected `.play-message-scroll` is not always
 *  the viewport the player moved. */
function findHistoryScrollContainer(
  marker: HTMLElement,
  fallback: HTMLElement | null,
): HTMLElement | null {
  let overflowCandidate: HTMLElement | null = null;
  let current = marker.parentElement;
  while (current) {
    const overflowY = current.ownerDocument.defaultView?.getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      overflowCandidate = current;
      if (current.scrollHeight > current.clientHeight) return current;
    }
    current = current.parentElement;
  }
  // A short transcript has no scroll owner yet. Keep the outermost overflow
  // viewport so we can still tell that the history does not fill it.
  return overflowCandidate ?? fallback;
}

function isHistoryViewportUnderfilled(
  viewport: HTMLElement | null,
  messageList: HTMLElement | null,
): boolean {
  return Boolean(
    viewport &&
    messageList &&
    viewport.clientHeight > 0 &&
    // Measure the transcript itself, not the creator wrapper's scrollHeight.
    // Verdant's fixed wrapper has 75px of layout padding, which creates a
    // scrollbar even when three messages leave most of the viewport empty.
    messageList.scrollHeight <= viewport.clientHeight + 1
  );
}

interface MessageListProps {
  rendererComponent: React.ComponentType<Record<string, unknown>> | null;
}

const AT_BOTTOM_THRESHOLD_PX = 80;

export function MessageList({ rendererComponent }: MessageListProps) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const messages = api.messages as unknown as SandboxMessage[];
  const isStreaming = api.isStreaming;
  const streamingContent = api.streamingContent;
  const streamingReasoning = api.streamingReasoning;
  const gameState = api.variables;
  const greetingContent = api.greetingContent;
  const error = api.error;
  const hasMessageHistory = messages.length > 0;
  const isGuestPreview = api.mode === "guest-preview";
  const canSendMessage = api.capabilities?.canSendMessage !== false && !isGuestPreview;

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const historySentinelRef = useRef<HTMLDivElement>(null);
  const laterSentinelRef = useRef<HTMLDivElement>(null);
  const laterArmedRef = useRef(false);
  const revealLaterRef = useRef<() => void>(() => {});
  const userScrolledUp = useRef(false);
  const readerMovingUntil = useRef(0);
  const freshReaderInput = useRef(false);
  const viewportScrollRef = useRef<(viewport: HTMLElement) => void>(() => {});
  const followLatestAlignRef = useRef<() => void>(() => {});
  const hasMountedRef = useRef(false);
  const releaseInitialAnchorRef = useRef<(() => void) | null>(null);
  const resumePositionRef = useRef<ReturnType<typeof trackTranscriptPosition> | null>(null);
  const historyRenderWaiters = useRef(new Set<() => void>());
  const historyAutoLoadArmedRef = useRef(false);
  const historyIntersectionSeenAwayRef = useRef(false);
  const historyAutoFillRequestKeyRef = useRef<string | null>(null);
  const requestEarlierFromViewportRef = useRef<(
    historyScrollElement: HTMLElement | null,
    scrollTop: number,
  ) => void>(() => {});
  const historyLoadInFlightRef = useRef(false);
  const historyLoadRequestTokenRef = useRef(0);
  const earlierAnchorRef = useRef<{ element: HTMLElement; firstId: string; offset: number } | null>(null);
  const historyJumpRef = useRef<{ element: HTMLElement; edge: ChatHistoryEdge; sessionId: string } | null>(null);
  const suppressHistoryAutoLoadRef = useRef(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [savingEditId, setSavingEditId] = useState<string | null>(null);
  const savingEditRef = useRef<string | null>(null);
  const [historyWindow, setHistoryWindow] = useState<ChatHistoryWindow | null>(null);
  const range = useMemo(() => chatHistoryRange(messages, historyWindow), [messages, historyWindow]);
  const activeMessages = useMemo(() => messages.slice(range.start, range.end), [messages, range.start, range.end]);
  const pendingOlderWindowRef = useRef<{ sessionId: string; firstId: string } | null>(null);
  const [historyLoadRequested, setHistoryLoadRequested] = useState(false);
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const currentPositionState = useRef({ api, historyWindow });
  currentPositionState.current = { api, historyWindow };

  // Reset dismiss when error changes
  useEffect(() => { setErrorDismissed(false); }, [error]);

  // ── Scroll management ──
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Reset on session change — fresh session starts with auto-scroll re-enabled.
  // The sandbox-wide scroll guard (component-host.tsx) also drops its
  // user-scrolled marks on session change, so both layers stay in sync.
  useEffect(() => {
    historyLoadRequestTokenRef.current += 1;
    hasMountedRef.current = false;
    userScrolledUp.current = false;
    readerMovingUntil.current = 0; freshReaderInput.current = false;
    historyAutoLoadArmedRef.current = false;
    historyIntersectionSeenAwayRef.current = false;
    historyAutoFillRequestKeyRef.current = null;
    historyLoadInFlightRef.current = false;
    earlierAnchorRef.current = null;
    historyJumpRef.current = null; suppressHistoryAutoLoadRef.current = false;
    setHistoryWindow(null);
    pendingOlderWindowRef.current = null;
    laterArmedRef.current = false;
    setEditingMessageId(null); setEditContent("");
    setHistoryLoadRequested(false);
    setHistoryLoadFailed(false);
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = 0;
    return () => {
      releaseInitialAnchorRef.current?.();
      releaseInitialAnchorRef.current = null;
      historyLoadRequestTokenRef.current += 1;
    };
  }, [api.sessionId]);

  // Auto-scroll: only on initial mount. Once the user has scrolled, we leave
  // the viewport alone — even when they send a new message — until the session
  // resets. The sandbox guard enforces the same rule for creator custom UI.
  useEffect(() => {
    if (messages.length === 0) return;
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      if (messages.length > 1 && !isGuestPreview && scrollContainerRef.current) {
        // Native setter is safe here: the anchor releases on real user input,
        // before any scroll. Layout-generated events must not block restoration.
        releaseInitialAnchorRef.current = anchorInitialTranscript(
          scrollContainerRef.current,
          setScrollTopRaw,
          () => { historyAutoLoadArmedRef.current = true; },
        );
      }
      return;
    }
    releaseInitialAnchorRef.current?.();
    releaseInitialAnchorRef.current = null;
    if (resumePositionRef.current?.updating()) return;
    const lastMsg = messages[messages.length - 1];
    if (!userScrolledUp.current && lastMsg?.role === "user") {
      scrollToBottom("smooth");
    }
  }, [api.sessionId, messages, isGuestPreview, scrollToBottom]);

  useEffect(() => {
    const list = scrollContainerRef.current;
    if (!list || !hasMessageHistory || isGuestPreview) return;
    const tracker = trackTranscriptPosition({
      sessionId: api.sessionId, list,
      viewport: () => historySentinelRef.current
        ? findHistoryScrollContainer(historySentinelRef.current, list) ?? list : list,
      setTop: setScrollTopRaw,
      expanded: () => currentPositionState.current.historyWindow !== null,
      loadedCount: () => currentPositionState.current.api.messages.length,
      reveal: async (position, signal) => {
        if (position.mode !== "reading" || !position.anchorId) { setHistoryWindow(null); return; }
        const revealAnchor = () => {
          const current = currentPositionState.current.api;
          if (!signal.aborted && current.sessionId === position.sessionId) {
            const selected = chatHistoryAround(current.messages, position.anchorId!);
            if (selected) setHistoryWindow(previous => previous?.firstId === selected.firstId && previous.lastId === selected.lastId
              && previous.size === selected.size && previous.followLatest === selected.followLatest ? previous : selected);
          }
        };
        revealAnchor();
        // Rehydrate at most the previously loaded range (+ one boundary page).
        // Each request remains server-bounded; never fetch the whole session.
        await restoreTranscriptHistory(position, signal, {
          current: () => currentPositionState.current.api,
          load: () => currentPositionState.current.api.loadEarlierMessages(),
          // Observe the actual channel/React commit, not an assumed bridge delay.
          committed: (previous) => new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              window.clearTimeout(timeout);
              historyRenderWaiters.current.delete(check);
              signal.removeEventListener("abort", abort);
            };
            const abort = () => { cleanup(); reject(new DOMException("Restoration canceled", "AbortError")); };
            const check = () => {
              const current = currentPositionState.current.api;
              if (signal.aborted || current.sessionId !== position.sessionId) { abort(); return; }
              if (current.messages[0]?.id !== previous.messages[0]?.id || !current.hasEarlierMessages ||
                  (previous.isLoadingEarlier && !current.isLoadingEarlier)) { cleanup(); resolve(); }
            };
            const timeout = window.setTimeout(() => { cleanup(); reject(new Error("History render timed out")); }, 10_000);
            historyRenderWaiters.current.add(check);
            signal.addEventListener("abort", abort, { once: true });
            check();
          }),
        });
        revealAnchor();
        // Finish restoration only after the selected bounded window commits.
        // A parent API response can arrive before its React/message channel.
        if (!signal.aborted && currentPositionState.current.api.messages.some(row => row.id === position.anchorId)) {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => { window.clearTimeout(timeout); historyRenderWaiters.current.delete(check); signal.removeEventListener("abort", abort); };
            const abort = () => { cleanup(); reject(new DOMException("Restoration canceled", "AbortError")); };
            const check = () => {
              if (signal.aborted || currentPositionState.current.api.sessionId !== position.sessionId) { abort(); return; }
              if (list.querySelector(`[data-mid="${CSS.escape(position.anchorId!)}"]`)) { cleanup(); resolve(); }
            };
            const timeout = window.setTimeout(() => { cleanup(); reject(new Error("History window render timed out")); }, 10_000);
            historyRenderWaiters.current.add(check); signal.addEventListener("abort", abort, { once: true }); check();
          });
        }
      },
      releaseInitial: () => {
        releaseInitialAnchorRef.current?.();
        releaseInitialAnchorRef.current = null;
      },
    });
    resumePositionRef.current = tracker;
    return () => { tracker.stop(); resumePositionRef.current = null; };
  }, [api.sessionId, hasMessageHistory, isGuestPreview]);

  useLayoutEffect(() => { resumePositionRef.current?.changed(); }, [messages]);
  useLayoutEffect(() => { resumePositionRef.current?.changed(false); }, [historyWindow]);
  useLayoutEffect(() => { historyRenderWaiters.current.forEach((check) => check()); }, [messages, api.isLoadingEarlier, api.hasEarlierMessages, historyWindow]);

  // A stable row anchor handles both inserted older rows and trimmed tails.
  const captureHistoryAnchor = useCallback((element: HTMLElement | null) => {
    const list = scrollContainerRef.current;
    if (!element || !list) return;
    const top = element.getBoundingClientRect().top;
    const row = Array.from(list.querySelectorAll<HTMLElement>("[data-mid]"))
      .find(candidate => candidate.getBoundingClientRect().bottom > top);
    if (!row?.dataset.mid) return;
    const rect = element.getBoundingClientRect();
    const scale = rect.height > 0 && element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
    freshReaderInput.current = false;
    earlierAnchorRef.current = { element, firstId: row.dataset.mid, offset: (row.getBoundingClientRect().top - top) / scale };
  }, []);

  // ── Server-side history pages ──
  // The host only holds a recent window of the transcript (mega sessions froze
  // the server serializing full histories); api.loadEarlierMessages() fetches
  // the previous page and PREPENDS it asynchronously. Anchoring differs from
  // the sync reveal above: rows arrive on a later render, so we remember the
  // currently visible row and its viewport-relative offset before loading,
  // then retain that anchor when rows arrive and the window changes.
  const handleLoadEarlier = useCallback(async (
    historyScrollElement: HTMLElement | null = null,
  ) => {
    historyScrollElement ??= historySentinelRef.current
      ? findHistoryScrollContainer(historySentinelRef.current, scrollContainerRef.current) : scrollContainerRef.current;
    const action = getEarlierHistoryAction(
      range.start,
      api.hasEarlierMessages,
    );
    if (action === "none" || historyLoadInFlightRef.current || api.isLoadingEarlier || editingMessageId || savingEditRef.current) return;
    suppressHistoryAutoLoadRef.current = false;

    releaseInitialAnchorRef.current?.();
    releaseInitialAnchorRef.current = null;
    historyLoadInFlightRef.current = true;
    const requestToken = ++historyLoadRequestTokenRef.current;
    setHistoryLoadRequested(true);
    setHistoryLoadFailed(false);

    const shouldLoadServer = action === "load-server" || action === "reveal-and-load";
    captureHistoryAnchor(historyScrollElement);
    if (shouldLoadServer && range.start === 0 && messages[0]) {
      pendingOlderWindowRef.current = { sessionId: api.sessionId, firstId: messages[0].id };
    }
    try {
      const loaded = await executeEarlierHistoryAction(action, {
        revealLocal: () => {
          setHistoryWindow(shiftChatHistory(messages, range, -1));
        },
        loadServer: api.loadEarlierMessages,
      });
      if (!loaded && historyLoadRequestTokenRef.current === requestToken) {
        earlierAnchorRef.current = null; pendingOlderWindowRef.current = null;
        setHistoryLoadFailed(true);
      }
    } finally {
      if (historyLoadRequestTokenRef.current === requestToken) {
        historyLoadInFlightRef.current = false;
        setHistoryLoadRequested(false);
      }
    }
  }, [messages, range, api.sessionId, api.hasEarlierMessages, api.isLoadingEarlier, api.loadEarlierMessages, captureHistoryAnchor, editingMessageId]);
  useLayoutEffect(() => {
    const jump = historyJumpRef.current;
    if (jump) {
      historyJumpRef.current = null;
      if (jump.sessionId === api.sessionId && jump.element.isConnected) {
        setScrollTopRaw(jump.element,jump.edge === "oldest" ? 0 : Math.max(0,jump.element.scrollHeight-jump.element.clientHeight));
      }
      return;
    }
    const pending = pendingOlderWindowRef.current;
    if (pending && pending.sessionId === api.sessionId && messages[0]?.id !== pending.firstId) {
      pendingOlderWindowRef.current = null;
      setHistoryWindow(shiftChatHistory(messages, range, -1));
      return;
    }
    const anchor = earlierAnchorRef.current, list = scrollContainerRef.current;
    if (!anchor || !list) return;
    const row = list.querySelector<HTMLElement>(`[data-mid="${CSS.escape(anchor.firstId)}"]`);
    if (!row) { earlierAnchorRef.current = null; return; }
    const rect = anchor.element.getBoundingClientRect();
    const scale = rect.height > 0 && anchor.element.offsetHeight > 0 ? rect.height / anchor.element.offsetHeight : 1;
    const delta = (row.getBoundingClientRect().top - rect.top) / scale - anchor.offset;
    if (Math.abs(delta) > 0.5 || !pendingOlderWindowRef.current) {
      earlierAnchorRef.current = null;
      if (Math.abs(delta) > 0.5) setScrollTopRaw(anchor.element, anchor.element.scrollTop + delta);
    }
  }, [messages, historyWindow, api.sessionId, range]);

  const handleShowNewer = useCallback(() => {
    if (editingMessageId || savingEditRef.current || range.end >= messages.length) return;
    suppressHistoryAutoLoadRef.current = false;
    const viewport = historySentinelRef.current
      ? findHistoryScrollContainer(historySentinelRef.current, scrollContainerRef.current) : scrollContainerRef.current;
    captureHistoryAnchor(viewport);
    const next = shiftChatHistory(messages, range, 1);
    setHistoryWindow(next);
    laterArmedRef.current = false;
    userScrolledUp.current = !next?.followLatest;
  }, [messages, range, editingMessageId, captureHistoryAnchor]);
  revealLaterRef.current = handleShowNewer;

  const handleHistoryJump = useCallback((edge: ChatHistoryEdge) => {
    if (!messages.length || editingMessageId || savingEditRef.current || historyLoadInFlightRef.current || api.isLoadingEarlier) return;
    const element = historySentinelRef.current
      ? findHistoryScrollContainer(historySentinelRef.current,scrollContainerRef.current) : scrollContainerRef.current;
    if (!element) return;
    resumePositionRef.current?.userNavigated();
    releaseInitialAnchorRef.current?.(); releaseInitialAnchorRef.current = null;
    earlierAnchorRef.current = null; pendingOlderWindowRef.current = null;
    readerMovingUntil.current = 0; freshReaderInput.current = false;
    laterArmedRef.current = false; historyAutoLoadArmedRef.current = false;
    historyIntersectionSeenAwayRef.current = false;
    // "Loaded" is a scope promise, including when the first loaded page is
    // shorter than its viewport. Only subsequent reader input may auto-page.
    suppressHistoryAutoLoadRef.current = true;
    historyJumpRef.current = {element,edge,sessionId:api.sessionId};
    userScrolledUp.current = edge !== "newest";
    setHistoryWindow(jumpChatHistory(messages,edge));
  },[messages,editingMessageId,api.isLoadingEarlier,api.sessionId]);

  // Explicit Newest / physical-bottom intent may resume built-in following
  // without clearing the sandbox's broader custom-interface scroll guard.
  useLayoutEffect(() => {
    const list = scrollContainerRef.current, view = list?.ownerDocument.defaultView;
    if (!list || !view || !historyWindow?.followLatest || editingMessageId || savingEditId) return;
    let frame: number | null = null, stopped = false;
    const align = () => {
      frame = null;
      const current = currentPositionState.current;
      if (stopped || list.ownerDocument.hidden || current.api.sessionId !== api.sessionId ||
          !current.historyWindow?.followLatest || resumePositionRef.current?.updating()) return;
      const viewport = historySentinelRef.current
        ? findHistoryScrollContainer(historySentinelRef.current, list) : list;
      if (viewport) setScrollTopRaw(viewport, Math.max(0, viewport.scrollHeight - viewport.clientHeight));
    };
    const schedule = () => { if (frame === null) frame = view.requestAnimationFrame(align); };
    followLatestAlignRef.current = align;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(list);
    if (list.firstElementChild) observer?.observe(list.firstElementChild);
    const viewport = historySentinelRef.current ? findHistoryScrollContainer(historySentinelRef.current, list) : list;
    if (viewport && viewport !== list) observer?.observe(viewport);
    align();
    return () => {
      stopped = true;
      if (frame !== null) view.cancelAnimationFrame(frame);
      observer?.disconnect();
      followLatestAlignRef.current = () => {};
    };
  }, [api.sessionId, historyWindow?.followLatest, editingMessageId, savingEditId]);
  useLayoutEffect(() => { followLatestAlignRef.current(); }, [messages, streamingContent, streamingReasoning, isStreaming, historyWindow]);

  const maybeRequestEarlierHistory = useCallback((
    historyScrollElement: HTMLElement | null,
    scrollTop: number,
  ) => {
    if (suppressHistoryAutoLoadRef.current) return;
    if (scrollTop > EARLIER_HISTORY_TOP_PX) {
      historyAutoLoadArmedRef.current = true;
    }

    const hiddenLocalCount = range.start;
    const action = getEarlierHistoryAction(hiddenLocalCount, api.hasEarlierMessages);
    const loading = historyLoadRequested || api.isLoadingEarlier || historyLoadInFlightRef.current;
    const autoFillKey = `${api.sessionId}:${messages[0]?.id ?? "empty"}:${messages.length}:${range.start}:${range.end}:${api.hasEarlierMessages ? 1 : 0}`;
    const viewportUnderfilled = isHistoryViewportUnderfilled(
      historyScrollElement,
      scrollContainerRef.current,
    );
    const canAutoFillViewport =
      viewportUnderfilled && activeMessages.length < MAX_CHAT_ROWS && historyAutoFillRequestKeyRef.current !== autoFillKey;
    if (shouldAutoRequestEarlierHistory({
      action,
      armed: historyAutoLoadArmedRef.current,
      failed: historyLoadFailed,
      loading,
      scrollTop,
      viewportUnderfilled: canAutoFillViewport,
    })) {
      if (canAutoFillViewport) historyAutoFillRequestKeyRef.current = autoFillKey;
      historyAutoLoadArmedRef.current = false;
      void handleLoadEarlier(historyScrollElement);
    }
  }, [api.hasEarlierMessages, api.isLoadingEarlier, api.sessionId, handleLoadEarlier, historyLoadFailed, historyLoadRequested, messages, range.start, range.end, activeMessages.length]);
  requestEarlierFromViewportRef.current = maybeRequestEarlierHistory;

  const handleViewportScroll = useCallback((el: HTMLElement) => {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD_PX;
    userScrolledUp.current = !atBottom;
    const manual = readerMovingUntil.current >= Date.now() && (freshReaderInput.current || !isInitialTranscriptScroll(el));
    if (manual) {
      freshReaderInput.current = false;
      readerMovingUntil.current = Date.now() + 1500;
      if (!atBottom && (!historyWindow || historyWindow.followLatest)) setHistoryWindow(selectChatHistory(messages, range));
      else if (atBottom && range.end === messages.length && !editingMessageId && !savingEditRef.current) {
        setHistoryWindow(selectChatHistory(messages, range, true));
      }
    }
    maybeRequestEarlierHistory(el, el.scrollTop);
    if (manual && atBottom) handleShowNewer();
  }, [maybeRequestEarlierHistory, handleShowNewer, messages, range, historyWindow, editingMessageId]);
  viewportScrollRef.current = handleViewportScroll;
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => handleViewportScroll(event.currentTarget), [handleViewportScroll]);

  useEffect(() => {
    if (!hasMessageHistory) return;
    const doc = scrollContainerRef.current?.ownerDocument;
    if (!doc) return;
    const viewport = () => historySentinelRef.current
      ? findHistoryScrollContainer(historySentinelRef.current, scrollContainerRef.current) : scrollContainerRef.current;
    const input = (event: Event) => {
      const el = viewport(), target = event.target;
      if (el && target instanceof doc.defaultView!.Node && el.contains(target) && isScrollIntent(event)) {
        suppressHistoryAutoLoadRef.current = false;
        readerMovingUntil.current = Date.now() + 1500; freshReaderInput.current = true;
        releaseInitialAnchorRef.current?.(); releaseInitialAnchorRef.current = null;
      }
    };
    const scroll = (event: Event) => {
      const el = viewport();
      if (el && el !== scrollContainerRef.current && event.target === el) viewportScrollRef.current(el);
    };
    for (const type of ["wheel", "touchmove", "keydown", "pointerdown"]) doc.addEventListener(type, input, { capture: true, passive: true });
    doc.addEventListener("scroll", scroll, { capture: true, passive: true });
    return () => {
      for (const type of ["wheel", "touchmove", "keydown", "pointerdown"]) doc.removeEventListener(type, input, true);
      doc.removeEventListener("scroll", scroll, true);
    };
  }, [hasMessageHistory]);

  // If the current page is too short to create a scrollbar, there is no user
  // scroll event and the marker never leaves the viewport. Re-check after each
  // prepended page until the viewport fills or the server reports no history.
  // The request key prevents a successful-but-empty response from looping.
  useEffect(() => {
    const marker = historySentinelRef.current;
    if (!marker) return;
    const historyScrollElement = findHistoryScrollContainer(
      marker,
      scrollContainerRef.current,
    );
    if (!isHistoryViewportUnderfilled(historyScrollElement, scrollContainerRef.current)) return;
    requestEarlierFromViewportRef.current(
      historyScrollElement,
      historyScrollElement?.scrollTop ?? 0,
    );
  }, [api.hasEarlierMessages, api.isLoadingEarlier, hasMessageHistory, historyLoadFailed, historyLoadRequested, messages.length, historyWindow]);

  // Observe the history marker itself instead of assuming the injected list is
  // the element being scrolled. IntersectionObserver accounts for every nested
  // overflow ancestor, including creator wrappers such as Verdant's fixed chat
  // viewport. Requiring one non-intersecting observation prevents an initial
  // top-position frame from loading history before the mount-time bottom scroll.
  useEffect(() => {
    const marker = historySentinelRef.current;
    if (!marker || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      const later = entries.find(candidate => candidate.target === laterSentinelRef.current);
      if (later && !later.isIntersecting) laterArmedRef.current = true;
      else if (later?.isIntersecting && laterArmedRef.current) revealLaterRef.current();
      const entry = entries.find((candidate) => candidate.target === marker);
      if (!entry) return;
      if (!entry.isIntersecting) {
        historyIntersectionSeenAwayRef.current = true;
        historyAutoLoadArmedRef.current = true;
        return;
      }
      const historyScrollElement = findHistoryScrollContainer(
        marker,
        scrollContainerRef.current,
      );
      if (
        !historyIntersectionSeenAwayRef.current &&
        !isHistoryViewportUnderfilled(historyScrollElement, scrollContainerRef.current)
      ) return;
      requestEarlierFromViewportRef.current(historyScrollElement, 0);
    });
    if (laterSentinelRef.current) observer.observe(laterSentinelRef.current);
    observer.observe(marker);
    return () => observer.disconnect();
  }, [hasMessageHistory]);

  // ── Edit handlers ──
  const handleStartEdit = useCallback((messageId: string, content: string) => {
    setHistoryWindow(selectChatHistory(messages, range));
    setEditingMessageId(messageId);
    setEditContent(content);
  }, [messages, range]);
  useEffect(() => {
    if (editingMessageId && !messages.some(message => message.id === editingMessageId)) {
      setEditingMessageId(null); setEditContent("");
    }
  }, [messages, editingMessageId]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditContent("");
  }, []);

  const handleSaveEdit = useCallback(async (messageId: string) => {
    if (savingEditRef.current) return;
    savingEditRef.current = messageId;
    setSavingEditId(messageId);
    try {
      const success = await api.editMessage(messageId, editContent);
      if (!success) {
        api.showToast(t("failedEdit"), "error");
        return;
      }
      setEditingMessageId(null);
      setEditContent("");
    } catch {
      api.showToast(t("failedEdit"), "error");
    } finally {
      savingEditRef.current = null;
      setSavingEditId(null);
    }
  }, [api, editContent, t]);

  // ── Messages ──
  // Compaction changes only prompt context. Every loaded row remains reachable
  // with its original edit, swipe and branch commands through bounded windows.
  // A bounded, overlapping history window keeps custom rich rows mounted
  // only while needed; message data and edit/branch commands remain untouched.
  const hiddenCount = range.start;
  const earlierHistoryAction = getEarlierHistoryAction(hiddenCount, api.hasEarlierMessages);
  const isEarlierHistoryLoading = historyLoadRequested || api.isLoadingEarlier;

  // ── Greeting (empty state) ──
  if (messages.length === 0 && !isStreaming) {
    if (greetingContent) {
      return (
        <div className="play-message-scroll flex-1 min-h-0 overflow-y-auto">
          <div className="play-message-stack">
            <MessageBubble
              message={{
                id: "__greeting__",
                sessionId: "",
                role: "assistant",
                content: greetingContent,
                createdAt: new Date().toISOString(),
              }}
              rendererComponent={rendererComponent}
              variables={gameState as Record<string, unknown>}
              messageIndex={0}
            />
            <div ref={bottomRef} className="h-4" />
          </div>
        </div>
      );
    }
    if (api.readOnly || !canSendMessage || isGuestPreview) {
      return <div className="flex-1" />;
    }
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground/40">
          {t("startConversation")}
        </p>
      </div>
    );
  }

  // ── Main message list ──
  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className="play-message-scroll flex-1 min-h-0 overflow-y-auto"
    >
      <div className="play-message-stack">
        {hasMessageHistory && <div role="group" aria-label={t("loadedHistory")}
          className="play-history-jumps sticky top-0 z-10 flex flex-wrap justify-end gap-1 bg-background/95 px-2 py-1">
          {(["oldest","newest"] as const).map(edge => <button key={edge} type="button" data-history-jump={edge}
            disabled={!!editingMessageId || !!savingEditId || isEarlierHistoryLoading}
            onClick={() => handleHistoryJump(edge)}
            className="min-h-10 rounded px-3 py-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
            {t(edge === "oldest" ? "oldestLoaded" : "newestLoaded")}
          </button>)}
        </div>}
        <div
          ref={historySentinelRef}
          data-history-sentinel="true"
          aria-hidden="true"
          style={{ height: 1, width: "100%" }}
        />
        {/* One history control covers both client windowing and server paging.
            Scrolling to the top triggers the same action automatically; this
            remains as an accessible keyboard/touch fallback and retry state. */}
        {isEarlierHistoryLoading ? (
          <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            className="mt-2 flex min-h-11 w-full items-center justify-center px-4 py-3 text-center text-sm text-muted-foreground"
          >
            {t("loadingEarlier")}
          </div>
        ) : earlierHistoryAction !== "none" ? (
          <button
            type="button" data-history-direction="older" disabled={!!editingMessageId || !!savingEditId}
            onClick={() => { void handleLoadEarlier(); }}
            className={`mt-2 min-h-11 w-full cursor-pointer px-4 py-3 text-center text-sm font-medium transition-colors active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              historyLoadFailed
                ? "text-destructive hover:text-destructive/80"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {historyLoadFailed ? t("loadEarlierFailed") : t("loadEarlier")}
          </button>
        ) : null}

        {/* Active messages */}
        {activeMessages.map((message, idx) => {
          const messageVars = ((message.stateSnapshot as Record<string, unknown> | null)
            ?.variables as Record<string, unknown> | undefined) ?? gameState;
          const prevRole = idx > 0 ? activeMessages[idx - 1]!.role : null;
          const showRoleLabel = message.role !== prevRole;
          const isEditingThis = editingMessageId === message.id;
          const isLastMessage = range.start + idx === messages.length - 1;
          const isLastAssistant = isLastMessage && message.role === "assistant";

          return (
            <div key={message.id} data-mid={message.id} className="play-message-row">
              <MessageBubble
                message={message}
                rendererComponent={rendererComponent}
                variables={messageVars as Record<string, unknown>}
                messageIndex={idx}
                showRoleLabel={showRoleLabel}
                isLastMessage={isLastMessage}
                actionsKey={`${isLastAssistant ? 1 : 0}${isLastMessage ? 1 : 0}:${message.swipes?.length ?? 0}:${message.status ?? ""}`}
                isEditing={isEditingThis}
                isSavingEdit={savingEditId === message.id}
                editContent={isEditingThis ? editContent : undefined}
                onEditContentChange={setEditContent}
                onSaveEdit={() => handleSaveEdit(message.id)}
                onCancelEdit={handleCancelEdit}
                swipeControls={
                  message.role === "assistant" ? (
                    <SwipeControls message={message} />
                  ) : undefined
                }
              >
                <MessageActions
                  message={message}
                  isLastAssistant={isLastAssistant}
                  isLastMessage={isLastMessage}
                  onEditStart={() => handleStartEdit(message.id, message.content)}
                />
              </MessageBubble>
            </div>
          );
        })}

        {range.end < messages.length && <button type="button" data-history-direction="newer"
          disabled={!!editingMessageId || !!savingEditId} onClick={handleShowNewer}
          className="mt-2 min-h-11 w-full px-4 py-3 text-center text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {t("loadNewer")}
        </button>}
        <div ref={laterSentinelRef} aria-hidden="true" style={{ height: 1 }} />

        {/* Platform-owned consent renders here, including creator-skinned chats. */}
        <div data-yumina-model-fallback-slot="true" />

        {/* Streaming message */}
        {range.end === messages.length && isStreaming && (streamingContent || streamingReasoning) && (
          <MessageBubble
            message={{
              id: "__streaming__",
              sessionId: "",
              role: "assistant",
              content: "",
              createdAt: new Date().toISOString(),
            }}
            isStreaming
            streamingContent={streamingContent}
            streamingReasoning={streamingReasoning}
            rendererComponent={rendererComponent}
            variables={gameState as Record<string, unknown>}
            messageIndex={activeMessages.length}
          />
        )}

        {/* Error banner */}
        {error && !errorDismissed && (
          <div
            role="alert"
            className="play-message-error flex min-w-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
          >
            <p className="play-message-error__text min-w-0 flex-1 text-xs text-destructive">{error}</p>
            <button
              type="button"
              onClick={() => setErrorDismissed(true)}
              className="play-message-error__dismiss shrink-0 text-xs text-destructive/60 hover:text-destructive"
            >
              Dismiss
            </button>
          </div>
        )}

        <div ref={bottomRef} className="h-4" />
      </div>
    </div>
  );
}
