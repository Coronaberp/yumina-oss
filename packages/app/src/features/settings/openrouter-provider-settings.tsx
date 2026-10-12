import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { OpenRouterProviderEndpoint } from "@yumina/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

const apiBase = import.meta.env?.VITE_API_URL || "";

/** Select exact upstream endpoints for one model on an OpenRouter profile. */
export function OpenRouterProviderSettings({ profileId, modelId, selected, onChange, disabled }: {
  profileId: string;
  modelId: string;
  selected: string[];
  onChange: (providers: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("profile");
  const id = useId();
  const [providers, setProviders] = useState<OpenRouterProviderEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${apiBase}/api/keys/${encodeURIComponent(profileId)}/openrouter-providers?model=${encodeURIComponent(modelId)}`, {
          credentials: "include", signal: controller.signal,
        });
        const payload = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok || !Array.isArray(payload.data?.providers)) {
          throw new Error(typeof payload.error === "string" ? payload.error : t("apiKeys.openRouterProviders.loadFailed"));
        }
        setProviders(payload.data.providers);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("apiKeys.openRouterProviders.loadFailed"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [profileId, modelId, refresh, t]);

  const knownSlugs = new Set(providers.map(provider => provider.slug));
  // Retain unavailable saved choices so a list refresh never broadens routing.
  const choices = [...providers, ...selected.filter(slug => !knownSlugs.has(slug)).map(slug => ({ slug, name: slug } as OpenRouterProviderEndpoint))];
  const price = (value: number) => (value * 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 3 });
  const retry = () => { setLoading(true); setError(null); setRefresh(value => value + 1); };

  return (
    <fieldset disabled={disabled} aria-describedby={`${id}-hint`} className="min-w-0 rounded-xl border border-white/10 bg-black/10 p-3">
      <legend className="px-1 text-[11px] font-semibold text-main">{t("apiKeys.openRouterProviders.title")}</legend>
      <p id={`${id}-hint`} className="mb-3 text-[11px] leading-relaxed text-sub/60">
        {t(selected.length ? "apiKeys.openRouterProviders.restrictedHint" : "apiKeys.openRouterProviders.accountHint")}
      </p>
      {selected.length > 0 && <Button type="button" size="sm" variant="ghost" onClick={() => onChange([])} disabled={disabled} className="mb-2 h-auto min-h-9 whitespace-normal text-xs">
        {t("apiKeys.openRouterProviders.useAccountDefaults")}
      </Button>}
      {loading && <p role="status" className="flex items-center gap-2 py-2 text-xs text-sub/60"><Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />{t("apiKeys.openRouterProviders.loading")}</p>}
      {error && <div role="alert" className="mb-2 space-y-2 text-xs text-red-300">
        <p>{error}</p>
        <Button type="button" size="sm" variant="outline" onClick={retry} disabled={disabled}>{t("apiKeys.openRouterProviders.retry")}</Button>
      </div>}
      {!loading && !error && choices.length === 0 && <p className="py-2 text-xs text-sub/60">{t("apiKeys.openRouterProviders.empty")}</p>}
      <div className="max-h-64 overflow-y-auto overscroll-contain" role="group" aria-label={t("apiKeys.openRouterProviders.title")}>
        {choices.map((provider, index) => (
          <label key={provider.slug} htmlFor={`${id}-${index}`} className="flex min-h-[52px] cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/[0.04]">
            <Checkbox id={`${id}-${index}`} aria-label={`${provider.name} (${provider.slug})`} checked={selected.includes(provider.slug)} disabled={disabled}
              onCheckedChange={checked => onChange(checked ? [...selected, provider.slug] : selected.filter(slug => slug !== provider.slug))} />
            <span className="min-w-0 flex-1 text-xs">
              <span className="block break-words font-medium text-main">{provider.name}</span>
              <span className="block break-all font-mono text-[10px] text-sub/50">{provider.slug}</span>
              {provider.pricing && <span className="block text-[10px] text-sub/50">{t("apiKeys.openRouterProviders.pricing", { input: price(provider.pricing.prompt), output: price(provider.pricing.completion) })}</span>}
              {!loading && !error && !knownSlugs.has(provider.slug) && <span className="block text-[10px] text-amber-300/80">{t("apiKeys.openRouterProviders.unavailable")}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
