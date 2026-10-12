import { useRef, useState } from "react";
import { Plus, Trash2, Upload, UserRound } from "lucide-react";
import type { PersonaPreset } from "@yumina/engine";
import { personaSpriteExpressions, type PersonaSpriteExpression } from "@yumina/shared";
import { useEditorStore } from "@/stores/editor";
import { useAssetStore } from "@/stores/assets";
import { resolveImageUrl } from "@/lib/asset-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldError } from "@/components/ui/field-error";

const EMPTY: PersonaPreset[] = [];
export function PersonasSection() {
  const presets = useEditorStore(s => s.worldDraft.personaPresets) ?? EMPTY;
  const setField = useEditorStore(s => s.setField);
  const worldId = useEditorStore(s => s.serverWorldId);
  const file = useRef<HTMLInputElement>(null);
  const spriteFile = useRef<HTMLInputElement>(null);
  const spriteTarget = useRef<{ personaId: string; expression: PersonaSpriteExpression } | null>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadingSpriteFor, setUploadingSpriteFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = (id: string, patch: Partial<PersonaPreset>) => setField("personaPresets", presets.map(p => p.id === id ? { ...p, ...patch } : p));
  const upload = async (image: File) => {
    if (!worldId || !uploadFor) return;
    const target = uploadFor;
    setUploading(true); setError(null);
    try {
      const asset = await useAssetStore.getState().uploadAsset(worldId, image, "image");
      if (!asset) throw new Error("Upload failed");
      const current = useEditorStore.getState();
      current.setField("personaPresets", (current.worldDraft.personaPresets ?? []).map(p => p.id === target ? { ...p, avatarUrl: asset.url } : p));
    } catch { setError("Could not upload the persona picture. Please try again."); }
    finally { setUploading(false); }
  };
  const uploadSprite = async (image: File) => {
    const target = spriteTarget.current;
    if (!worldId || !target) return;
    const uploadKey = `${target.personaId}:${target.expression}`;
    setUploadingSpriteFor(uploadKey); setError(null);
    try {
      const asset = await useAssetStore.getState().uploadAsset(worldId, image, "image");
      if (!asset) throw new Error("Upload failed");
      const current = useEditorStore.getState();
      current.setField("personaPresets", (current.worldDraft.personaPresets ?? []).map(p => {
        if (p.id !== target.personaId) return p;
        return { ...p, sprites: { ...p.sprites, [target.expression]: asset.url } };
      }));
    } catch { setError("Could not upload this persona sprite. Please try again."); }
    finally { setUploadingSpriteFor(null); spriteTarget.current = null; }
  };
  const removeSprite = (personaId: string, expression: PersonaSpriteExpression) => {
    const current = useEditorStore.getState();
    current.setField("personaPresets", (current.worldDraft.personaPresets ?? []).map(p => {
      if (p.id !== personaId || !p.sprites) return p;
      const sprites = { ...p.sprites };
      delete sprites[expression];
      return { ...p, sprites };
    }));
  };
  return <section className="space-y-5 p-5 sm:p-7">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-xl font-semibold text-foreground">Personas</h2>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">Offer player characters for this card. Players can choose a creator persona or their own during the greeting.</p>
        <p className="mt-1 max-w-xl text-xs text-muted-foreground">Identity details only. Stats and starting values come from the story's variables and rules.</p></div>
      <Button disabled={presets.length >= 50} onClick={() => setField("personaPresets", [...presets, { id: crypto.randomUUID(), name: "New persona" }])}><Plus className="mr-2 h-4 w-4" />Add persona</Button>
    </div>
    <FieldError message={error} />
    <input ref={file} type="file" accept="image/*" className="hidden" onChange={e => { const image = e.target.files?.[0]; if (image) void upload(image); e.target.value = ""; }} />
    <input ref={spriteFile} type="file" accept="image/*" aria-label="Persona expression sprite file" className="hidden" onChange={e => { const image = e.target.files?.[0]; if (image) void uploadSprite(image); e.target.value = ""; }} />
    {!presets.length && <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">No creator personas yet. Players can still use their own personas.</p>}
    {presets.map(p => <article key={p.id} className="space-y-4 rounded-xl border border-border bg-background/30 p-4 sm:p-5">
      <div className="flex items-center gap-3">
        {p.avatarUrl ? <img src={resolveImageUrl(p.avatarUrl) ?? undefined} alt="" className="h-12 w-12 shrink-0 rounded-xl object-cover" /> : <UserRound className="h-10 w-10 shrink-0 text-primary/60" />}
        <label className="min-w-0 flex-1 text-xs text-muted-foreground">Name<Input aria-label="Persona name" maxLength={50} value={p.name} onChange={e => change(p.id, { name: e.target.value })} className="mt-1" /></label>
        <Button variant="ghost" size="icon" aria-label={`Remove ${p.name}`} onClick={() => setField("personaPresets", presets.filter(row => row.id !== p.id))}><Trash2 className="h-4 w-4" /></Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 text-xs text-muted-foreground">Picture URL<Input aria-label="Persona picture URL" value={p.avatarUrl ?? ""} maxLength={2048} onChange={e => change(p.id, { avatarUrl: e.target.value || null })} className="mt-1" /></label>
        <Button variant="outline" disabled={!worldId || uploading} onClick={() => { setUploadFor(p.id); file.current?.click(); }}><Upload className="mr-2 h-4 w-4" />{uploading && uploadFor === p.id ? "Uploading…" : "Upload picture"}</Button>
      </div>
      {!worldId && <p className="text-xs text-muted-foreground">Save the card first to upload a picture.</p>}
      <section aria-label={`${p.name} VN stage sprites`} className="space-y-3 rounded-lg border border-border bg-card/40 p-3">
        <div><h3 className="text-sm font-semibold text-foreground">VN stage sprites</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Add transparent cutouts for the player's six expressions. These appear on stage when this persona speaks.</p></div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {personaSpriteExpressions.map(expression => {
            const ref = p.sprites?.[expression];
            const preview = resolveImageUrl(ref);
            const label = expression[0]!.toUpperCase() + expression.slice(1);
            const key = `${p.id}:${expression}`;
            return <article key={expression} className="overflow-hidden rounded-lg border border-border bg-background">
              <div className="flex h-36 items-center justify-center bg-muted/40 p-2">{preview ? <img src={preview} alt={`${p.name} ${expression} sprite`} className="h-full max-w-full object-contain" /> : <UserRound className="h-8 w-8 text-muted-foreground/40" />}</div>
              <div className="space-y-2 border-t border-border p-2">
                <p className="text-center text-xs font-medium text-muted-foreground">{label}</p>
                <Button variant="outline" disabled={!worldId || uploading || uploadingSpriteFor !== null} aria-label={`Upload ${expression} sprite for ${p.name}`} onClick={() => { spriteTarget.current = { personaId: p.id, expression }; spriteFile.current?.click(); }} className="h-9 w-full px-2 text-xs">
                  <Upload className="mr-1 h-3.5 w-3.5" />{uploadingSpriteFor === key ? "Uploading…" : preview ? "Replace" : "Upload"}
                </Button>
                {ref && <Button variant="ghost" disabled={uploading || uploadingSpriteFor !== null} aria-label={`Remove ${expression} sprite for ${p.name}`} onClick={() => removeSprite(p.id, expression)} className="h-8 w-full px-2 text-xs">Remove</Button>}
              </div>
            </article>;
          })}
        </div>
        {!worldId && <p className="text-xs text-muted-foreground">Save the card first to upload sprites.</p>}
      </section>
      {([['appearance', 'Appearance', 2000], ['personality', 'Personality', 2000], ['backstory', 'Background', 5000]] as const).map(([key, label, max]) => <label key={key} className="block text-xs text-muted-foreground">{label}<textarea aria-label={`Persona ${label.toLowerCase()}`} value={p[key] ?? ""} maxLength={max} rows={3} onChange={e => change(p.id, { [key]: e.target.value })} className="mt-1 block w-full resize-y rounded-lg border border-border bg-background p-3 text-sm text-foreground outline-none focus:border-primary" /></label>)}
    </article>)}
  </section>;
}
