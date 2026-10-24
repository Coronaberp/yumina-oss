import React, { createContext, use, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { YuminaContext, type SandboxedYuminaAPI } from "../sandbox-context";

type ChatReads = Pick<SandboxedYuminaAPI, "language" | "user" | "entries" | "variables" | "isStreaming" | "modelFallback">;
type ChatActions = Pick<SandboxedYuminaAPI,
  "sendMessage" | "continueLastMessage" | "setModel" | "showToast" | "copyToClipboard" | "deleteMessage" |
  "regenerateMessage" | "revertToMessage" | "branchFromMessage" | "navigate" | "swipeMessage">;
type BuiltinChatAPI = ChatReads & ChatActions;
const BuiltinChatContext = createContext<BuiltinChatAPI | null>(null);

/** Private to platform message rows. The public SDK context remains complete
 * and reactive for creator components, custom renderers and extensions. */
export function BuiltinChatProvider({ api, children }: { api: SandboxedYuminaAPI; children?: React.ReactNode }) {
  const committedAPI = useRef(api);
  useLayoutEffect(() => { committedAPI.current = api; }, [api]);
  // buildAPI allocates closures for each SDK snapshot. Stable delegates avoid
  // token-only invalidation while preserving the latest capability/session
  // guards when an event actually invokes the SDK.
  const actions = useMemo<ChatActions>(() => ({
    sendMessage: (...args) => committedAPI.current.sendMessage(...args),
    continueLastMessage: (...args) => committedAPI.current.continueLastMessage(...args),
    setModel: (...args) => committedAPI.current.setModel(...args),
    showToast: (...args) => committedAPI.current.showToast(...args),
    copyToClipboard: (...args) => committedAPI.current.copyToClipboard(...args),
    deleteMessage: (...args) => committedAPI.current.deleteMessage(...args),
    regenerateMessage: (...args) => committedAPI.current.regenerateMessage(...args),
    revertToMessage: (...args) => committedAPI.current.revertToMessage(...args),
    branchFromMessage: (...args) => committedAPI.current.branchFromMessage(...args),
    navigate: (...args) => committedAPI.current.navigate(...args),
    swipeMessage: (...args) => committedAPI.current.swipeMessage(...args),
  }), []);
  const name = api.user?.name ?? "Player", avatar = api.user?.avatar ?? null, sprites = api.user?.sprites;
  const user = useMemo(() => ({ name, avatar, sprites }), [name, avatar, sprites]);
  // ComponentHost retains unchanged channel references. In particular entries
  // come from the session channel; variable aliases cache by their source bag.
  // No lore serialization or deep comparison runs for a streaming update.
  const { language, entries, variables, isStreaming, modelFallback } = api;
  const value = useMemo<BuiltinChatAPI>(() => ({ ...actions, language, user, entries, variables, isStreaming, modelFallback }),
    [actions, language, user, entries, variables, isStreaming, modelFallback]);
  return <BuiltinChatContext.Provider value={value}>{children}</BuiltinChatContext.Provider>;
}

export function useBuiltinChat(): BuiltinChatAPI {
  const narrow = useContext(BuiltinChatContext);
  // React 19's conditional use() preserves legacy direct embeddings without
  // subscribing normal hosted rows to both the narrow and full contexts.
  return narrow ?? use(YuminaContext);
}
