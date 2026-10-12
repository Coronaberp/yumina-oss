import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { lazyRouteComponent } from "@/lib/lazy-route-component";
import { getEditorMode, getGlobalEditorMode } from "@/features/editor/quick-create-editor";
import { useUnsavedChangesGuard } from "@/features/editor/use-unsaved-changes-guard";
import { UnsavedChangesDialog } from "@/features/editor/unsaved-changes-dialog";
import { navigateBackSafely } from "@/lib/safe-back";

const EditorShell = lazyRouteComponent(
  () => import("@/features/editor/editor-shell"),
  (m) => m.EditorShell
);

const QuickCreateEditor = lazyRouteComponent(
  () => import("@/features/editor/quick-create-editor"),
  (m) => m.QuickCreateEditor
);

function WorldEditPage() {
  const { worldId } = Route.useParams();
  const router = useRouter();
  const loadWorld = useEditorStore((s) => s.loadWorld);
  const loadingWorld = useEditorStore((s) => s.loadingWorld);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const editorMode = useEditorStore((s) => s.worldDraft.editorMode);
  const isDirty = useEditorStore((s) => s.isDirty);
  const editingLocked = useEditorStore((s) => s.editingLocked);
  const setReadOnlyInspect = useEditorStore((s) => s.setReadOnlyInspect);
  const [modeOverride, setModeOverride] = useState<{ worldId: string; simple: boolean } | null>(null);
  const simpleMode = serverWorldId !== worldId ? null
    : modeOverride?.worldId === worldId ? modeOverride.simple
    : (editorMode ?? getEditorMode(worldId) ?? getGlobalEditorMode()) === "simple";
  const setSimpleMode = (simple: boolean) => setModeOverride({ worldId, simple });

  // Block SPA navigation + browser close when there are unsaved changes
  const blocker = useUnsavedChangesGuard(isDirty);

  useEffect(() => {
    loadWorld(worldId);
    return () => { useEditorStore.getState().stopAutosave(); };
  }, [worldId, loadWorld]);

  useEffect(() => {
    setReadOnlyInspect(editingLocked);
    return () => setReadOnlyInspect(false);
  }, [editingLocked, setReadOnlyInspect]);

  // Show spinner while loading or before the correct world is in the store
  if (loadingWorld || serverWorldId !== worldId || simpleMode === null) {
    return <LoadingSpinner />;
  }

  if (editingLocked) return (
    <Suspense fallback={<LoadingSpinner />}>
      <EditorShell />
    </Suspense>
  );

  if (simpleMode) {
    return (
      <>
        <Suspense fallback={<LoadingSpinner />}>
          <QuickCreateEditor
            onOpenFullEditor={() => setSimpleMode(false)}
            onBack={() => {
              navigateBackSafely(
                router.history,
                `/app/library?worldId=${encodeURIComponent(worldId)}`,
              );
            }}
          />
        </Suspense>
        <UnsavedChangesDialog blocker={blocker} />
      </>
    );
  }

  return (
    <>
      <Suspense fallback={<LoadingSpinner />}>
        <EditorShell onSwitchToSimple={() => setSimpleMode(true)} />
      </Suspense>
      <UnsavedChangesDialog blocker={blocker} />
    </>
  );
}

export const Route = createFileRoute("/app/worlds/$worldId/edit")({
  component: WorldEditPage,
});

function LoadingSpinner() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
    </div>
  );
}
