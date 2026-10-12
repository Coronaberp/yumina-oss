import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { WorldEntry } from "@yumina/engine";
import { DebouncedInput } from "./debounced-field";

export function GreetingNameField({ greeting, onCommit }: { greeting: WorldEntry; onCommit: (name: string) => void }) {
  const { t } = useTranslation("editor");
  const id = useId();
  return <div className="space-y-1.5">
    <label htmlFor={id} className="block text-sm font-medium text-foreground">{t("firstMessage.nameLabel")}</label>
    <DebouncedInput
      id={id}
      value={greeting.name}
      syncKey={greeting.id}
      onCommit={onCommit}
      maxLength={50}
      placeholder={t("firstMessage.namePlaceholder")}
      aria-describedby={`${id}-hint`}
      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
    />
    <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t("firstMessage.nameHint")}</p>
  </div>;
}
