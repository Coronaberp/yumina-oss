import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RootComponent } from "@yumina/engine";
import type { StatusConfig } from "../../../../../../interfaces/vn/status-data";
import { useSandbox } from "@/features/sandbox/use-sandbox";
import { bundleTSX } from "@/features/studio/lib/tsx-bundler";
import { buildStatusPreviewFiles } from "../lib/status-visualizations";

export function StatusLayoutPreview({ root, config, variables, templates, worldName, category, categoryRevision = 0, label = "Status layout preview", onValidationChange }: {
  root: RootComponent; config: StatusConfig; variables: Record<string, unknown>;
  templates: Record<string, string>; worldName: string;
  category?: string; categoryRevision?: number;
  label?: string; onValidationChange?: (state: { ready: boolean; error: string }) => void;
}) {
  const input = useMemo(() => buildStatusPreviewFiles(root, config, templates), [root, config, templates]);
  const result = useMemo(() => bundleTSX(input), [input]);
  const [runtimeFailure, setRuntimeFailure] = useState<{ input: typeof input; message: string } | null>(null);
  const error = result.error || (runtimeFailure?.input === input ? runtimeFailure.message : "");
  const version = useRef(0);
  const iframe = useRef<HTMLIFrameElement | null>(null);
  const latestCategory = useRef(category);
  const { installRoot, pushChannel, iframeRefCallback, sandboxUrl, rendered, assetError } = useSandbox({
    onApiCall: () => { throw new Error("This status preview is read-only."); },
    onStreamCall: (_method, _args, callbacks) => callbacks.onError("Generation is unavailable in this status preview."),
    onError: message => setRuntimeFailure({ input, message }),
  });
  const attachFrame = useCallback((element: HTMLIFrameElement | null) => {
    iframe.current = element;
    iframeRefCallback(element);
  }, [iframeRefCallback]);
  useEffect(() => { latestCategory.current = category; }, [category]);
  const sendCategory = useCallback(() => {
    if (!latestCategory.current) return;
    // The sandbox has an opaque origin; the preview receiver verifies our source and origin.
    iframe.current?.contentWindow?.postMessage({ type: "yumina-status-preview-category", categoryId: latestCategory.current }, "*");
  }, []);
  useEffect(() => {
    const onReceiverReady = (event: MessageEvent) => {
      if (event.source === iframe.current?.contentWindow && event.data?.type === "yumina-status-preview-ready") sendCategory();
    };
    window.addEventListener("message", onReceiverReady);
    return () => window.removeEventListener("message", onReceiverReady);
  }, [sendCategory]);
  useEffect(() => {
    installRoot(input.entryFile, input.files, result.code ?? undefined, result.error ?? undefined, "guest-preview");
  }, [input, result, installRoot]);
  useEffect(() => {
    const next = ++version.current;
    pushChannel("variables", { variables, globalVariables: {} }, next);
    pushChannel("messages", { messages: [] }, next);
    pushChannel("session", { worldId: "", worldName, worldCover: null, sessionId: "", currentUser: null,
      user: { name: "Player", avatar: null }, entries: [], loreUiBindings: [], worldbooks: [] }, next);
  }, [variables, worldName, pushChannel]);
  useEffect(() => {
    if (rendered) sendCategory();
  }, [category, categoryRevision, rendered, sendCategory]);
  useEffect(() => {
    onValidationChange?.({ ready: rendered && !error && !assetError, error: error || (assetError ? "A preview image or font could not load." : "") });
  }, [rendered, error, assetError, onValidationChange]);

  return <div className="overflow-hidden rounded-xl border border-border bg-[#18130f]">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 text-xs text-muted-foreground"><span>{label === "Status layout preview" ? "Status preview" : label}</span><span>Right sheet · preview values</span></div>
    {error && <p role="alert" className="border-b border-border p-3 text-xs text-destructive">This design could not be previewed. Ask the agent to repair your status layout.</p>}
    {!error && assetError && <p role="alert" className="border-b border-border p-3 text-xs text-destructive">A preview image or font could not load. Check the card’s assets and reopen this preview.</p>}
    {!error && !rendered && !assetError && <p role="status" className="border-b border-border p-3 text-xs text-muted-foreground">Loading status preview…</p>}
    <iframe ref={attachFrame} src={sandboxUrl} title={label} sandbox="allow-scripts" className={`block h-[600px] w-full border-0 ${error ? "hidden" : ""}`} />
  </div>;
}
