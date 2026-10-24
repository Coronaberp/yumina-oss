import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { feedback } from "@/lib/feedback";
import { useWorldsStore } from "@/stores/worlds";

const apiBase = import.meta.env.VITE_API_URL || "";

/** One request at a time, shared by the card grid and editor actions. */
export function useDuplicateCard() {
  const { t } = useTranslation("library");
  const navigate = useNavigate();
  const busy = useRef(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  async function duplicateCard(worldId: string, beforeCopy?: () => Promise<boolean>) {
    if (busy.current) return;
    busy.current = true;
    setDuplicatingId(worldId);
    try {
      if (beforeCopy && !await beforeCopy()) return;
      const response = await fetch(`${apiBase}/api/worlds/${encodeURIComponent(worldId)}/duplicate`, { method: "POST", credentials: "include" });
      const result = await response.json();
      if (!response.ok || !result.data?.id) throw Error(typeof result.error === "string" ? result.error : t("card.duplicateFailed"));
      useWorldsStore.getState().invalidate();
      await navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: result.data.id } });
    } catch (error) {
      feedback.error(error instanceof Error ? error.message : t("card.duplicateFailed"));
    } finally {
      busy.current = false;
      setDuplicatingId(null);
    }
  }
  return { duplicateCard, duplicatingId };
}
