import { useEffect, useMemo, useRef, useState } from "react";
import type { RootComponent } from "@yumina/engine";
import type { StatusConfig } from "../../../../../../interfaces/vn/status-data";
import { useSandbox } from "@/features/sandbox/use-sandbox";
import { bundleTSX } from "@/features/studio/lib/tsx-bundler";
import { buildStatusPreviewFiles } from "../lib/status-visualizations";

export function StatusLayoutPreview({ root, config, variables, templates, worldName }: {
  root: RootComponent; config: StatusConfig; variables: Record<string, unknown>;
  templates: Record<string, string>; worldName: string;
}) {
  const input = useMemo(() => buildStatusPreviewFiles(root, config, templates), [root, config, templates]);
  const result = useMemo(() => bundleTSX(input), [input]);
  const [runtimeFailure, setRuntimeFailure] = useState<{ input: typeof input; message: string } | null>(null);
  const error = result.error || (runtimeFailure?.input === input ? runtimeFailure.message : "");
  const version = useRef(0);
  const { installRoot, pushChannel, iframeRefCallback, sandboxUrl } = useSandbox({
    onApiCall: () => { throw new Error("This status preview is read-only."); },
    onStreamCall: (_method, _args, callbacks) => callbacks.onError("Generation is unavailable in this status preview."),
    onError: message => setRuntimeFailure({ input, message }),
  });
  useEffect(() => {
    installRoot(input.entryFile, input.files, result.code ?? undefined, result.error ?? undefined, "guest-preview");
  }, [input, result, installRoot]);
  useEffect(() => {
    const next = ++version.current;
    pushChannel("variables", { variables, globalVariables: {} }, next);
    pushChannel("session", { worldId: "", worldName, worldCover: null, sessionId: "", currentUser: null,
      user: { name: "Player", avatar: null }, entries: [], loreUiBindings: [], worldbooks: [] }, next);
  }, [variables, worldName, pushChannel]);

  return <div className="overflow-hidden rounded-xl border border-border bg-[#18130f]">
    <div className="flex items-center justify-between border-b border-border px-4 py-3 text-xs text-muted-foreground"><span>Status preview</span><span>Right sheet · starting values</span></div>
    {error && <p role="alert" className="border-b border-border p-3 text-xs text-destructive">This design could not be previewed. Ask the agent to repair your status layout.</p>}
    <iframe ref={iframeRefCallback} src={sandboxUrl} title="Status layout preview" sandbox="allow-scripts" className={`block h-[600px] w-full border-0 ${error ? "hidden" : ""}`} />
  </div>;
}
