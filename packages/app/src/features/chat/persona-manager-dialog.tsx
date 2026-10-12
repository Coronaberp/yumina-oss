import { personaPresetsSchema } from "@yumina/engine";
import { resolveImageUrl } from "@/lib/asset-url";
import { UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PersonaCarousel } from "@/features/personas/persona-carousel";
import { PersonaEditModal } from "@/features/personas/persona-edit-modal";
import { useChatStore } from "@/stores/chat";
import { FieldError } from "@/components/ui/field-error";
import { usePersonasStore, type Persona } from "@/stores/personas";
import { createChatPersonaController, PersonaSaveUnconfirmedError } from "@/lib/refresh-chat-persona";

interface PersonaManagerDialogProps {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
}

/** Exactly one selected identity belongs to this save; greeting changes remain available. */
export function PersonaManagerDialog({ open, onClose, sessionId }: PersonaManagerDialogProps) {
  const { t } = useTranslation("profile");
  const [editingPersona, setEditingPersona] = useState<Persona | null | undefined>(undefined);

  const [saving, setSaving] = useState(false);
  const [pendingName, setPendingName] = useState("");
  // R3/R4: the dialog stays open, so the failure belongs inside it — under the
  // carousel the user just clicked, never in a pill.
  const [saveError, setSaveError] = useState<string | null>(null);
  const streaming = useChatStore((s) => s.isStreaming);
  const session = useChatStore((s) => s.session);
  const hasPlayed = useChatStore(s => s.messages.some(m => m.role === "user"));
  const readOnly = useChatStore(s => s.readOnly);
  const selectable = !readOnly && !hasPlayed && session?.personaSelectable !== false && !session?.sessionPersona?.started && Number(session?.state?.turnCount ?? 0) === 0;
  const presetData = personaPresetsSchema.safeParse(session?.world?.schema?.personaPresets ?? []);
  const presets = presetData.success ? presetData.data : [];
  const saved = session && session.id === sessionId ? session.sessionPersona?.persona : undefined;
  const source = usePersonasStore((s) => s.personas.find((p) => p.id === saved?.id));
  const fetchPersonas = usePersonasStore((s) => s.fetchPersonas);
  // Only committed selection/public-field changes refresh identity.
  const sourceVersion = source ? JSON.stringify([
    source.id, source.name, source.avatarUrl, source.appearance, source.personality, source.backstory, source.entries,
  ]) : null;
  const controller = useRef<ReturnType<typeof createChatPersonaController> | null>(null);
  useEffect(() => {
    setSaving(false);
    setSaveError(null);
    if (!sessionId) return;
    const current = createChatPersonaController({
      sessionId, apiBase: import.meta.env.VITE_API_URL || "",
      getState: useChatStore.getState,
      apply: (session) => useChatStore.setState({ session }),
      onSaving: setSaving,
      onError: (error) => setSaveError(error ? t(error instanceof PersonaSaveUnconfirmedError ? "persona.session.unconfirmed" : "persona.session.saveError") : null),
      onEvent: (event) => { void import("@/lib/analytics").then(({ captureHubEvent }) => captureHubEvent("persona_selection", event)).catch(() => {}); },
    });
    controller.current = current;
    return () => { current.dispose(); controller.current = null; };
  }, [sessionId, t]);
  useEffect(() => { controller.current?.setBlocked(streaming); }, [sessionId, streaming, t]);
  // Dismissing the dialog does not cancel an in-flight save or identity refresh.
  useEffect(() => { if (open) controller.current?.refresh(); }, [open, sessionId, t]);
  useEffect(() => {
    if (!sessionId) return;
    const refreshVisible = () => {
      if (document.visibilityState === "hidden") return;
      void fetchPersonas(true);
      controller.current?.refresh();
    };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [sessionId, fetchPersonas]);
  const previousSource = useRef({ sessionId, sourceVersion });
  useEffect(() => {
    const previous = previousSource.current;
    if (selectable && previous.sessionId === sessionId && previous.sourceVersion !== sourceVersion) {
      // The receipt can change the source itself; refresh only real profile edits.
      const committed = useChatStore.getState().session?.sessionPersona?.persona;
      const version = (p: typeof source | typeof committed) => p ? JSON.stringify([
        p.id, p.name, p.avatarUrl ?? null, p.appearance ?? null, p.personality ?? null, p.backstory ?? null, p.entries ?? [],
      ]) : null;
      if (version(source) !== version(committed)) controller.current?.refresh();
    }
    previousSource.current = { sessionId, sourceVersion };
  }, [sessionId, sourceVersion, selectable]);
  const select = async (personaId: string) => {
    setPendingName(usePersonasStore.getState().personas.find((p) => p.id === personaId)?.name ?? "Player");
    if (selectable) await controller.current?.select(personaId);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="border-white/10 bg-card p-6 text-main shadow-2xl shadow-gold/5 sm:max-w-[500px] sm:rounded-3xl max-h-[85dvh] overflow-y-auto">
          <DialogTitle className="flex items-center gap-3 pr-10"><UserRound aria-hidden="true" />Personas</DialogTitle>
          {!selectable && <p className="text-sm text-muted-foreground">The greeting has ended. This story keeps its selected persona; start a new story to choose another.</p>}
          <p className="text-sm text-muted-foreground">{t("persona.session.current", { name: saved?.name ?? "Player" })}</p>
          {selectable && <p className="text-xs text-muted-foreground">Choose one persona for this story. You can change it until you proceed beyond the greeting.</p>}
          <fieldset disabled={saving || streaming || !sessionId || !selectable} className="min-w-0 disabled:opacity-60">
            <PersonaCarousel onEdit={(persona) => setEditingPersona(persona)}
              disabled={saving || streaming || !sessionId || !selectable}
              sessionSelection={{ personaId: session?.sessionPersona?.selection?.kind === "preset" ? null : saved?.id ?? null, hasPersona: !!saved, onSelect: select }} />
          </fieldset>
          {presets.length > 0 && <section className="space-y-2">
            <h3 className="text-sm font-semibold">Creator personas</h3>
            <div className="max-h-48 space-y-2 overflow-y-auto">
              {presets.map(preset => <button key={preset.id} type="button" disabled={saving || streaming || !sessionId || !selectable}
                aria-pressed={session?.sessionPersona?.selection?.kind === "preset" && session.sessionPersona.selection.id === preset.id}
                onClick={() => { setPendingName(preset.name); void controller.current?.selectPreset(preset.id); }}
                className="flex w-full items-center gap-3 rounded-xl border border-white/10 p-3 text-left hover:border-gold/40 disabled:opacity-50 aria-pressed:border-gold/50 aria-pressed:bg-gold/10">
                {preset.avatarUrl ? <img src={resolveImageUrl(preset.avatarUrl) ?? undefined} alt="" className="h-10 w-10 rounded-lg object-cover" /> : <UserRound className="h-5 w-5 text-gold/70" />}
                <span className="min-w-0"><span className="block truncate text-sm">{preset.name}</span>{preset.backstory && <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">{preset.backstory}</span>}</span>
              </button>)}
            </div>
          </section>}
          {(saving || streaming) && <p role="status" className="text-sm text-muted-foreground">{t(saving ? "persona.session.saving" : "persona.session.streaming", { name: pendingName })}</p>}
          <FieldError message={saveError} />
        </DialogContent>
      </Dialog>
      <PersonaEditModal
        isOpen={editingPersona !== undefined}
        onClose={() => setEditingPersona(undefined)}
        persona={editingPersona ?? null}
      />
    </>
  );
}
