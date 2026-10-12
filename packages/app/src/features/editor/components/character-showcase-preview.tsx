import { useEffect, useMemo, useRef, useState } from "react";
import type { WorldDefinition } from "@yumina/engine";
import { useSandbox } from "@/features/sandbox/use-sandbox";
import { bundleTSX } from "@/features/studio/lib/tsx-bundler";
import { buildCharacterShowcasePreview } from "../lib/character-showcase";

export function CharacterShowcasePreview({ world, characterId }: { world: WorldDefinition; characterId: string }) {
  const input = useMemo(() => {
    try { return { ...buildCharacterShowcasePreview(world, characterId), error: "" }; }
    catch (error) { return { entryFile: "", files: {}, variables: {}, entries: [], error: error instanceof Error ? error.message : "Unable to preview the showcase." }; }
  }, [world, characterId]);
  const result = useMemo(() => input.error ? { code: undefined, error: input.error } : bundleTSX(input), [input]);
  const [failure, setFailure] = useState<{ input: typeof input; message: string } | null>(null);
  const error = result.error || (failure?.input === input ? failure.message : "");
  const version = useRef(0);
  const { installRoot, pushChannel, iframeRefCallback, sandboxUrl } = useSandbox({
    onApiCall: () => { throw new Error("This character preview is read-only."); },
    onStreamCall: (_method, _args, callbacks) => callbacks.onError("Generation is unavailable in this preview."),
    onError: message => setFailure({ input, message }),
  });
  useEffect(() => {
    installRoot(input.entryFile, input.files, result.code ?? undefined, result.error ?? undefined, "guest-preview");
  }, [input, result, installRoot]);
  useEffect(() => {
    const next = ++version.current;
    pushChannel("variables", { variables: input.variables, globalVariables: {} }, next);
    pushChannel("session", { worldId: "", worldName: world.name, worldCover: null, sessionId: "", currentUser: null,
      user: { name: "Player", avatar: null }, entries: input.entries, loreUiBindings: [], worldbooks: [] }, next);
  }, [input, world.name, pushChannel]);
  return <div className="overflow-hidden rounded-xl border border-border bg-[#18130f]">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 text-xs text-muted-foreground"><span>Live preview</span><span>Starting stats · sample summary</span></div>
    {error && <p role="alert" className="p-4 text-xs text-destructive">{error}</p>}
    <iframe ref={iframeRefCallback} src={sandboxUrl} title="Character showcase preview" sandbox="allow-scripts" className={`block h-[720px] w-full border-0 ${error ? "hidden" : ""}`} />
  </div>;
}
