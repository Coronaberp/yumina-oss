import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PROFILE_SAMPLING_DEFAULTS, type ApiKeyMetadata } from "@yumina/shared";
import { Input } from "@/components/ui/input";

type SamplingKey = keyof typeof PROFILE_SAMPLING_DEFAULTS;
const controls = [
  { key: "temperature", min: 0, max: 2, step: "any" },
  { key: "topP", min: 0, max: 1, step: "any" },
  { key: "topK", min: 0, max: 100_000, step: 1 },
] as const;

export function useEndpointSampling(metadata?: ApiKeyMetadata | null) {
  const [inputs, setInputs] = useState<Record<SamplingKey, string>>(() => ({
    temperature: String(metadata?.temperature ?? PROFILE_SAMPLING_DEFAULTS.temperature),
    topP: String(metadata?.topP ?? PROFILE_SAMPLING_DEFAULTS.topP),
    topK: String(metadata?.topK ?? PROFILE_SAMPLING_DEFAULTS.topK),
  }));
  const values = Object.fromEntries(controls.map(({ key }) => [key, inputs[key].trim() ? Number(inputs[key]) : PROFILE_SAMPLING_DEFAULTS[key]])) as Record<SamplingKey, number>;
  const invalid = Object.fromEntries(controls.map(({ key, min, max }) => {
    const value = values[key];
    return [key, !Number.isFinite(value) || value < min || value > max || (key === "topP" && value === 0) || (key === "topK" && !Number.isInteger(value))];
  })) as Record<SamplingKey, boolean>;
  const changes = Object.fromEntries(controls.filter(({ key }) => values[key] !== (metadata?.[key] ?? PROFILE_SAMPLING_DEFAULTS[key])).map(({ key }) => [key, values[key]]));
  return { inputs, setInputs, values, invalid, hasInvalid: Object.values(invalid).some(Boolean), changes, dirty: Object.keys(changes).length > 0 };
}

export function EndpointCreativitySettings({ id, sampling, disabled }: {
  id: string;
  sampling: ReturnType<typeof useEndpointSampling>;
  disabled?: boolean;
}) {
  const { t } = useTranslation("profile");
  return <fieldset disabled={disabled} className="min-w-0 rounded-xl border border-white/10 bg-white/[0.02] px-4 pb-4 pt-2">
    <legend className="px-1 text-xs font-semibold text-main">{t("apiKeys.creativity.title")}</legend>
    <p className="mb-4 text-[11px] leading-relaxed text-sub/70">{t("apiKeys.creativity.intro")}</p>
    <div className="grid gap-4 sm:grid-cols-3">
      {controls.map(({ key, min, max, step }) => {
        const inputId = `endpoint-${id}-${key}`;
        const label = t(`apiKeys.creativity.${key}Label`);
        return <div key={key} className="min-w-0">
          <label htmlFor={inputId} className="mb-1 block text-[11px] text-sub/80">{label}</label>
          <Input id={inputId} aria-label={label} aria-describedby={`${inputId}-hint`} aria-invalid={sampling.invalid[key]}
            type="number" inputMode={key === "topK" ? "numeric" : "decimal"} min={min} max={max} step={step}
            value={sampling.inputs[key]} onChange={event => sampling.setInputs(previous => ({ ...previous, [key]: event.target.value }))}
            placeholder={String(PROFILE_SAMPLING_DEFAULTS[key])} className="profile-overview-input-surface w-full border-white/10 font-mono text-xs" />
          <p id={`${inputId}-hint`} className={`mt-1.5 text-[10px] leading-relaxed ${sampling.invalid[key] ? "text-red-300" : "text-sub/60"}`}>
            {t(`apiKeys.creativity.${key}${sampling.invalid[key] ? "Invalid" : "Hint"}`)}
          </p>
        </div>;
      })}
    </div>
    <p className="mt-4 text-[10px] leading-relaxed text-sub/50">{t("apiKeys.creativity.supportHint")}</p>
  </fieldset>;
}
