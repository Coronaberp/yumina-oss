import { useNavigate } from "@tanstack/react-router";
import type { WorldItem } from "@/stores/worlds";
import { usePlayWithLanguage } from "@/hooks/use-play-with-language";
import { LibraryGameCard } from "./library-game-card";

export function LibrarySharedExamples({ worlds, userId, searchQuery, onSelectItem }: {
  worlds: WorldItem[]; userId: string; searchQuery: string; onSelectItem: (item: WorldItem) => void;
}) {
  const navigate = useNavigate();
  const { handlePlay } = usePlayWithLanguage({
    onNavigate: (sessionId, returnContext) => navigate({ to: "/app/chat/$sessionId", params: { sessionId }, search: { moderationGroupKey: undefined, ...returnContext } }),
    historySource: "library", historyInteraction: "play-click",
  });
  const examples = worlds.filter(world => world.sharedInLibrary && world.creatorId !== userId && world.name.toLowerCase().includes(searchQuery.trim().toLowerCase()));
  if (!examples.length) return null;
  return <section className="library-section-stack mb-8" aria-label="Example cards">
    <div className="library-section-header px-2">
      <h2 className="library-list-title text-2xl font-black tracking-tight text-foreground">Example cards</h2>
      <p className="mt-1 text-sm text-muted-foreground">Play these shared examples or view their read-only editor.</p>
    </div>
    <div className="library-card-grid">
      {examples.map(item => <LibraryGameCard key={item.id} item={item} onClick={() => onSelectItem(item)}
        onPlay={() => void handlePlay(item)}
        onEdit={() => navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: item.id } })} />)}
    </div>
  </section>;
}
