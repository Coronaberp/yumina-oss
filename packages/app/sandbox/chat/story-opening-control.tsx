import { GitBranch } from "lucide-react";
import { useYumina } from "../sandbox-context";
import { canSelectStoryOpening } from "../../src/lib/can-select-story-opening";
import { makeChatT } from "./i18n";

/** Built into Chat so saved cards inherit the starting picker without TSX edits. */
export function StoryOpeningControl() {
  const api = useYumina();
  const available = canSelectStoryOpening({
    session: api.sessionId ? { personaSelectable: api.personaSelectable } : null,
    messages: api.messages,
    readOnly: api.readOnly,
    isStreaming: api.isStreaming,
    hasEarlierMessages: api.hasEarlierMessages,
  });
  if (!available) return null;
  const t = makeChatT(api.language);
  return <div data-chat-routes className="flex w-full shrink-0 justify-start px-4 py-2">
    <button type="button" aria-label={t("openRoutes")} aria-haspopup="dialog" onClick={() => api.openStoryRoutes()}
      className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground transition-colors hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <GitBranch className="h-4 w-4" aria-hidden="true" />{t("routes")}
    </button>
  </div>;
}
