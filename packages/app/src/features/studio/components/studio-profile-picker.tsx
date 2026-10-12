import { useEffect, useState } from "react";
import { Select } from "@/components/ui/select";
import { feedback } from "@/lib/feedback";
import { formatModelId } from "@yumina/shared";

type Selection = { source: "default" } | { source: "nsfw" } | { source: "profile"; profileId: string };
type Profile = { selection: Selection; label: string; model: string | null; reasoningEffort?: string };
type ProfileChoices = { selection: Selection | null; current: { model: string; label: string; reasoningEffort?: string } | null; profiles: Profile[] };
const apiBase = import.meta.env.VITE_API_URL || "";
const modelName = (model: string | null) => model === "codex/gpt-6-luna" ? "GPT-6 Luna" : model ? formatModelId(model) : "Configure a profile";

export function StudioProfilePicker({ refreshKey, disabled, onResolved }: {
  refreshKey?: string | null;
  disabled?: boolean;
  onResolved: (model: string | null, error: string | null) => void;
}) {
  const [choices, setChoices] = useState<ProfileChoices | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(`${apiBase}/api/keys/studio-provider`, { credentials: "include" });
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload.data?.profiles)) throw new Error("Could not load agent profiles. Refresh Yumina and try again.");
        if (alive) {
          setChoices(payload.data);
          onResolved(payload.data.current?.model ?? null, payload.data.current ? null : "Choose a configured agent profile in the profile picker.");
        }
      } catch (error) {
        if (alive) onResolved(null, error instanceof Error ? error.message : "Could not load agent profiles.");
      }
    })();
    return () => { alive = false; };
  }, [refreshKey, onResolved]);

  const select = async (value: string) => {
    const profile = choices?.profiles.find(p => JSON.stringify(p.selection) === value);
    if (!profile || saving) return;
    setSaving(true);
    try {
      const response = await fetch(`${apiBase}/api/keys/studio-provider`, {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile.selection),
      });
      const payload = await response.json();
      if (!response.ok || !payload.data?.current) throw new Error(payload.error ?? "Could not save the agent profile.");
      setChoices(payload.data);
      onResolved(payload.data.current.model, null);
    } catch (error) {
      feedback.error(error instanceof Error ? error.message : "Could not save the agent profile.");
    } finally { setSaving(false); }
  };
  const current = choices?.current;
  const effort = current?.reasoningEffort;
  return <div className="min-w-0 flex-1">
    <Select aria-label="Agent profile" value={JSON.stringify(choices?.selection ?? { source: "default" })}
      options={(choices?.profiles ?? []).map(profile => ({ value: JSON.stringify(profile.selection), label: profile.label,
        description: modelName(profile.model) + (profile.reasoningEffort === "max" ? " · Max reasoning" : "") }))}
      onValueChange={value => { void select(value); }} disabled={disabled || saving || !choices}
      placeholder="Loading agent profiles…"
      triggerClassName="min-h-11 rounded-md border-transparent bg-transparent px-2 py-1 text-xs shadow-none"
      contentClassName="max-w-[calc(100vw-1.5rem)] max-h-[min(300px,var(--radix-dropdown-menu-content-available-height))]" />
    <p className="truncate px-2 text-[10px] text-primary/80" title={modelName(current?.model ?? null)}>
      {modelName(current?.model ?? null)}{effort === "max" ? " · Max reasoning" : ""}
    </p>
  </div>;
}
