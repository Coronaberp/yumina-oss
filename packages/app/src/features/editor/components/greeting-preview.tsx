import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_CHAT_ROOT, GameStateManager, ResponseParser, expandMacros, type WorldDefinition, type WorldEntry } from "@yumina/engine";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSandbox } from "@/features/sandbox/use-sandbox";
import { bundleTSX } from "@/features/studio/lib/tsx-bundler";

export interface GreetingPreviewSnapshot {
  world: WorldDefinition;
  greeting: WorldEntry;
}

function GreetingChatFrame({ world, greeting }: GreetingPreviewSnapshot) {
  const { t, i18n } = useTranslation("editor");
  const [runtimeError, setRuntimeError] = useState("");
  const input = useMemo(() => world.rootComponent ?? {
    entryFile: "index.tsx", files: { "index.tsx": DEFAULT_CHAT_ROOT },
  }, [world]);
  const compiled = useMemo(() => bundleTSX(input), [input]);
  const sample = useMemo(() => {
    const state = new GameStateManager(world).getSnapshot();
    const variables = { ...state.variables, ...greeting.initialVariables };
    const raw = expandMacros(greeting.content, world, { ...state, variables });
    return { variables, raw, content: new ResponseParser().parse(raw).cleanText };
  }, [world, greeting]);
  const { installRoot, pushChannel, setMediaSuspended, iframeRefCallback, sandboxUrl, rendered, assetError } = useSandbox({
    onApiCall: () => { throw new Error("This greeting preview is read-only."); },
    onStreamCall: (_method, _args, callbacks) => callbacks.onError("Generation is unavailable in this greeting preview."),
    onError: setRuntimeError,
  });
  useEffect(() => {
    installRoot(input.entryFile, input.files, compiled.code ?? undefined, compiled.error ?? undefined, "guest-preview");
    setMediaSuspended(true);
  }, [input, compiled, installRoot, setMediaSuspended]);
  useEffect(() => {
    const version = 1;
    pushChannel("variables", { variables: sample.variables, globalVariables: {} }, version);
    pushChannel("messages", { messages: [{
      id: `greeting-preview-${greeting.id}`, role: "assistant", content: sample.content, status: "complete",
      activeSwipeIndex: 0, swipes: [{ content: sample.content, rawContent: sample.raw }],
    }] }, version);
    pushChannel("streaming", { isStreaming: false, content: "", reasoning: "", bg: null }, version);
    pushChannel("session", {
      worldId: "", worldName: world.name, worldCover: null, sessionId: "", currentUser: null,
      user: { name: world.settings.playerName || "Player", avatar: null },
      entries: world.entries.filter(entry => entry.enabled), loreUiBindings: world.loreUiBindings ?? [], worldbooks: world.worldbooks ?? [],
    }, version);
    pushChannel("ui", {
      pendingChoices: [], error: null, readOnly: true, checkpoints: [], greetingContent: sample.content,
      selectedModel: "", userPlan: "", memorySummaryEnabled: false, installedExtensions: [],
      preferredProvider: "official", localBridge: null, mixMode: false, modelPool: [],
      hasEarlierMessages: false, isLoadingEarlier: false, bgmVolume: 0, sfxVolume: 0,
      language: i18n.resolvedLanguage || "en", balance: null, mode: "guest-preview",
      capabilities: { canSendMessage: false, canPersistSession: false, canUseSessionApis: false, requiresAuth: false },
      composerSendKey: "enter", uiFontScale: 1,
      sendFailureNonce: 0, storyProgress: { status: "playing" }, isCompletingEnding: false, endingError: null,
    }, version);
  }, [sample, greeting.id, world, i18n.resolvedLanguage, pushChannel]);
  const error = compiled.error || runtimeError;
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
    {error && <p role="alert" className="shrink-0 p-4 text-sm text-destructive">{t("firstMessage.previewError")}</p>}
    {!error && assetError && <p role="alert" className="shrink-0 p-4 text-sm text-destructive">{t("firstMessage.previewAssetError")}</p>}
    {!error && !assetError && !rendered && <p role="status" className="shrink-0 p-4 text-sm text-muted-foreground">{t("firstMessage.previewLoading")}</p>}
    <iframe ref={iframeRefCallback} src={sandboxUrl} title="Greeting chat preview" sandbox="allow-scripts"
      className={`min-h-0 w-full flex-1 border-0 ${error ? "hidden" : ""}`} />
  </div>;
}

export function GreetingPreviewModal({ snapshot, onClose }: { snapshot: GreetingPreviewSnapshot; onClose: () => void }) {
  const { t } = useTranslation("editor");
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="flex h-[min(85dvh,760px)] max-w-4xl flex-col overflow-hidden p-4 sm:p-6">
      <DialogHeader className="shrink-0 pr-7">
        <DialogTitle>{t("firstMessage.previewTitle")}</DialogTitle>
        <p className="text-sm font-medium text-foreground">{snapshot.greeting.name}</p>
        <DialogDescription>{t("firstMessage.previewDescription")}</DialogDescription>
      </DialogHeader>
      {snapshot.greeting.content.trim() ? <GreetingChatFrame {...snapshot} />
        : <p className="py-10 text-center text-sm text-muted-foreground">{t("firstMessage.previewEmpty")}</p>}
    </DialogContent>
  </Dialog>;
}
