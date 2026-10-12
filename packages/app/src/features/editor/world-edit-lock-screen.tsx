import { LockKeyhole } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useEditorStore } from "@/stores/editor";

export function WorldEditLockScreen() {
  const { t } = useTranslation("editor");
  const name = useEditorStore(s => s.worldDraft.name);
  return <main className="flex h-full min-h-64 items-center justify-center bg-background p-6">
    <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center">
      <LockKeyhole className="mx-auto mb-4 h-8 w-8 text-primary" />
      <h1 className="text-xl font-semibold text-foreground">{t("shell.cardLocked", { defaultValue: "Card locked" })}</h1>
      <p className="mt-3 break-words text-sm text-muted-foreground">{name}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t("shell.cardLockedDescription", { defaultValue: "Editing and Studio changes are temporarily disabled. You can still play this card from your library." })}</p>
      <Link to="/app/library" className="mt-5 inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground">{t("shell.backToLibrary", { defaultValue: "Back to library" })}</Link>
    </div>
  </main>;
}
