import { STORY_SFW_ROUTING_MIN_PROBABILITY } from "@yumina/shared";
import { AlertCircle, ExternalLink, Pencil, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

export type ContentEndpointKind = "sfw" | "nsfw";
export type ContentEndpointProfile = {
  id: string;
  provider: string;
  label: string;
  baseUrl: string | null;
  metadata?: { defaultModel?: string } | null;
};
export type ContentEndpointSelection = { sfwApiKeyId: string | null; nsfwApiKeyId: string | null;
  defaults?: Partial<Record<ContentEndpointKind, { provider: string; model: string }>> };

export const CONTENT_ENDPOINT_TITLES: Record<ContentEndpointKind, string> = {
  sfw: "SFW provider", nsfw: "NSFW provider",
};
export function parseContentEndpointSelection(value: unknown): ContentEndpointSelection | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (!["sfwApiKeyId", "nsfwApiKeyId"].every(key => data[key] === null || typeof data[key] === "string")) return null;
  const selection: ContentEndpointSelection = { sfwApiKeyId: data.sfwApiKeyId as string | null, nsfwApiKeyId: data.nsfwApiKeyId as string | null };
  if (data.defaults && typeof data.defaults === 'object') {
    selection.defaults = {};
    for (const kind of ['sfw', 'nsfw'] as const) {
      const value = (data.defaults as Record<string, unknown>)[kind];
      if (!value || typeof value !== 'object') continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.provider === 'string' && typeof entry.model === 'string' && entry.model.trim()) {
        selection.defaults[kind] = { provider: entry.provider, model: entry.model };
      }
    }
  }
  return selection;
}

type Props = {
  profiles: ContentEndpointProfile[];
  selection: ContentEndpointSelection;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onAssign: (kind: ContentEndpointKind, id: string | null) => void;
  onEdit: (kind: ContentEndpointKind, id: string) => void;
  onCreate: (kind: ContentEndpointKind) => void;
  onRetry: () => void;
};

function profileText(profile: ContentEndpointProfile, fallback: string): string {
  return profile.baseUrl?.trim() || profile.metadata?.defaultModel?.trim() || fallback;
}

export function ContentEndpointCards({ profiles, selection, loading, busy, error, onAssign, onEdit, onCreate, onRetry }: Props) {
  const { t } = useTranslation("profile");
  const label = (key: string, fallback: string, values?: Record<string, unknown>) => t(`contentEndpoints.${key}`, { defaultValue: fallback, ...values });
  const renderCard = (kind: ContentEndpointKind) => {
    const currentId = selection[`${kind}ApiKeyId`];
    const current = profiles.find(profile => profile.id === currentId) ?? null;
    const adminDefault = selection.defaults?.[kind];
    const inherited = !currentId ? adminDefault : null;
    const options = [
      { value: "__none__", label: adminDefault ? label('adminDefault', 'Admin default') : label("unconfigured", "Not configured") },
      ...profiles.map(profile => ({ value: profile.id, label: profile.label || profile.id, description: profileText(profile, label("noDetails", "Custom endpoint")) })),
    ];
    const descriptions = {
      sfw: `Story uses this connection at ${STORY_SFW_ROUTING_MIN_PROBABILITY * 100}% SFW confidence or above.`,
      nsfw: "Little Idot uses this connection. Story switches here before sending NSFW or uncertain content.",
    };
    const headingId = `content-endpoint-${kind}-title`;
    return <section key={kind} aria-labelledby={headingId} className="rounded-2xl border border-border bg-card/60 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-foreground"><ShieldCheck className="h-4 w-4 shrink-0 text-primary" />{label(`${kind}Title`, CONTENT_ENDPOINT_TITLES[kind])}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{label(`${kind}Description`, descriptions[kind])}</p>
        </div>
        {(current || inherited) && <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">{inherited ? label('adminDefault', 'Admin default') : label("configured", "Configured")}</span>}
      </div>
      <div className="mt-4" role="group" aria-labelledby={headingId}>
        <Select value={currentId ?? "__none__"} onValueChange={value => onAssign(kind, value === "__none__" || value === "" ? null : value)} options={options} disabled={loading || busy} placeholder={label("select", "Select an endpoint")} triggerClassName="border-border bg-background" />
      </div>
      {current ? <div className="mt-3 space-y-1 rounded-xl border border-border/70 bg-background/50 p-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground"><span className="truncate">{current.label}</span><span className="text-muted-foreground/50">·</span><span>{current.provider}</span></div>
        {current.baseUrl && <div className="flex items-start gap-1 break-all"><ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />{current.baseUrl}</div>}
        {current.metadata?.defaultModel && <div>{label("model", "Model")}: <span className="text-foreground/80">{current.metadata.defaultModel}</span></div>}
      </div> : inherited ? <div className="mt-3 space-y-1 rounded-xl border border-border/70 bg-background/50 p-3 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">{label('adminDefault', 'Admin default')} · {inherited.provider}</div>
        <div className="break-words">{label('model', 'Model')}: <span className="text-foreground/80">{inherited.model}</span></div>
        <p>{label('adminModelLocked', 'This exact model is fixed by the administrator. The API key stays on the server.')}</p>
        <p>{label('adminDefaultHint', 'Uses the provider configured by the administrator. Select your own profile to override it.')}</p>
      </div> : <p className="mt-3 text-xs text-muted-foreground">{label(`${kind}Empty`, `No ${CONTENT_ENDPOINT_TITLES[kind]} selected.`)}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {current && <Button type="button" variant="outline" size="sm" disabled={busy || loading} onClick={() => onEdit(kind, current.id)}><Pencil />{label("edit", "Edit profile")}</Button>}
        <Button type="button" variant="outline" size="sm" disabled={busy || loading} onClick={() => onCreate(kind)}><Plus />{label("create", "Create profile")}</Button>
      </div>
    </section>;
  };
  return <div className="space-y-3">
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">{renderCard("sfw")}{renderCard("nsfw")}</div>
    <p className="text-xs text-muted-foreground">{label("routingHint", "Kev checks complete messages. NSFW, uncertain and failed checks use the NSFW provider before sending. If that connection is unavailable, sending is blocked.")}</p>
    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"><span className="flex items-center gap-2"><AlertCircle className="h-4 w-4 shrink-0" />{error}</span><Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRetry}><RefreshCw />{label("retry", "Retry")}</Button></div>}
  </div>;
}
