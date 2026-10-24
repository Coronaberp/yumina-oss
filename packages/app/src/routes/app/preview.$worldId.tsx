import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { lazyRouteComponent } from "@/lib/lazy-route-component";
import { parseSafeInternalReturnUrl, parseStoryReturnKey } from "@/lib/story-return-url";

const WorldPreview = lazyRouteComponent(
  () => import("@/features/chat/world-preview"),
  (m) => m.WorldPreview
);

function PreviewRoute() {
  const { worldId } = Route.useParams();
  const { adminPreview, ...returnContext } = Route.useSearch();
  return (
    <Suspense fallback={<Loading />}>
      <WorldPreview worldId={worldId} returnContext={returnContext} adminPreview={adminPreview} />
    </Suspense>
  );
}

export const Route = createFileRoute("/app/preview/$worldId")({
  validateSearch: (search: Record<string, unknown>): { returnTo?: string; returnKey?: string; adminPreview: boolean } => ({
    returnTo: parseSafeInternalReturnUrl(search.returnTo),
    returnKey: parseStoryReturnKey(search.returnKey),
    adminPreview: search.adminPreview === true || search.adminPreview === "true",
  }),
  component: PreviewRoute,
});

function Loading() {
    return (
        <div className="flex h-full w-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
        </div>
    );
}
