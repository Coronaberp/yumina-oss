import { useEffect, useState } from "react";
import { Check, ChevronDown, Plus, UserRound } from "lucide-react";
import { personaPresetsSchema, type PersonaPreset } from "@yumina/engine";
import type { PersonaSelection } from "@yumina/shared";
import { usePersonasStore } from "@/stores/personas";
import { PersonaEditModal } from "./persona-edit-modal";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { resolveImageUrl } from "@/lib/asset-url";

export function StoryPersonaPicker({ worldId, value, onChange, disabled }: { worldId: string; value: PersonaSelection; onChange: (selection: PersonaSelection) => void; disabled?: boolean }) {
  const personas = usePersonasStore(s => s.personas);
  const fetchPersonas = usePersonasStore(s => s.fetchPersonas);
  const [presets, setPresets] = useState<PersonaPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => { void fetchPersonas(); }, [fetchPersonas]);
  useEffect(() => {
    const controller = new AbortController();
    setPresets([]); setLoading(true); setFailed(false); onChange({ kind: "account" });
    void fetch(`${import.meta.env.VITE_API_URL || ""}/api/worlds/${worldId}`, { credentials: "include", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(({ data }) => { const parsed = personaPresetsSchema.safeParse(data.schema?.personaPresets ?? []); if (!parsed.success) throw new Error(); if (!controller.signal.aborted) setPresets(parsed.data); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [worldId, onChange]);
  const chosen = value.kind === "preset" ? presets.find(p => p.id === value.id) : value.kind === "player" ? personas.find(p => p.id === value.id) : value.kind === "account" ? personas.find(p => p.isActive) : null;
  const selected = (choice: PersonaSelection) => value.kind === choice.kind && (!('id' in choice) || 'id' in value && choice.id === value.id);
  const item = (choice: PersonaSelection, name: string, avatar?: string | null) => <DropdownMenuItem key={`${choice.kind}:${'id' in choice ? choice.id : ''}`} role="menuitemradio" aria-checked={selected(choice)} disabled={disabled} onSelect={() => onChange(choice)} className="gap-3 rounded-lg py-2">
    {avatar ? <img src={resolveImageUrl(avatar) ?? undefined} className="h-8 w-8 shrink-0 rounded-lg object-cover" alt="" /> : <UserRound className="h-5 w-5 shrink-0 text-primary/70" />}<span className="min-w-0 flex-1 truncate">{name}</span>{selected(choice) && <Check className="h-4 w-4" />}
  </DropdownMenuItem>;
  const matches = (name: string) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim());
  return <>
    <DropdownMenu open={open} onOpenChange={next => { setOpen(next); setQuery(""); }}>
      <DropdownMenuTrigger asChild><button disabled={disabled} className="flex w-full items-center gap-3 rounded-xl border border-border bg-background/40 px-3 py-2 text-left text-sm text-foreground">
        <UserRound className="h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">Persona for new story</span><span className="block truncate">{chosen?.name ?? 'Player'}{value.kind === 'preset' ? ' · Creator' : ''}</span></span><ChevronDown className="h-4 w-4" />
      </button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="z-[110] w-[min(24rem,calc(100vw-3rem))] rounded-xl p-2">
        <input aria-label="Search personas" placeholder="Search personas…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.stopPropagation()} className="mb-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary" />
        <div className="max-h-64 overflow-y-auto">
          {!query && item({ kind: 'account' }, `${personas.find(p => p.isActive)?.name ?? 'Player'} · Default`)}
          <p className="px-2 py-2 text-xs font-medium text-muted-foreground">My personas</p>
          {personas.filter(p => matches(p.name)).map(p => item({ kind: 'player', id: p.id }, p.name, p.avatarUrl))}
          {!personas.length && <p className="px-2 pb-2 text-xs text-muted-foreground">Create your own persona below.</p>}
          <p className="px-2 py-2 text-xs font-medium text-muted-foreground">Creator personas</p>
          {presets.filter(p => matches(p.name)).map(p => item({ kind: 'preset', id: p.id }, p.name, p.avatarUrl))}
          {!presets.length && <p className="px-2 pb-2 text-xs text-muted-foreground">{loading ? 'Loading…' : failed ? 'Could not load creator personas. Reopen the story picker to retry.' : 'This card has no creator personas.'}</p>}
        </div>
        <DropdownMenuItem disabled={disabled} onSelect={() => setCreating(true)} className="mt-1 gap-2 border-t border-border py-3"><Plus className="h-4 w-4" />Create my persona</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <PersonaEditModal isOpen={creating} onClose={() => setCreating(false)} />
  </>;
}
