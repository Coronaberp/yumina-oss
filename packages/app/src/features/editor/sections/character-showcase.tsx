import { useMemo, useState } from "react";
import { CARD_SHOWCASE_HTML_LIMIT, CARD_SHOWCASE_CSS_LIMIT, readCardShowcase, updateCardShowcase, type CardShowcase as CardShowcaseData } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { CardShowcase } from "@/components/card-showcase";
import { DebouncedTextarea } from "../components/debounced-field";

const controlClass = "w-full min-w-0 rounded-xl border border-border bg-card px-4 py-3 font-mono text-xs leading-relaxed text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50";
const htmlExample = '<section class="profile-section">\n  <h2>About this story</h2>\n  <p>Introduce the world and its characters here.</p>\n</section>';
const cssExample = '.card-showcase {\n  background: #1b1f2b;\n  color: #f2edf5;\n}\n\n.profile-section {\n  padding: 24px;\n  border: 1px solid #ffffff20;\n  border-radius: 12px;\n}';

export function CharacterShowcaseSection() {
  const world = useEditorStore(s => s.worldDraft);
  const cover = world.avatar;
  const readOnly = useEditorStore(s => s.readOnlyInspect || s.guestMode);
  const setField = useEditorStore(s => s.setField);
  const [error, setError] = useState("");
  const parsed = useMemo(() => {
    try { return { config: readCardShowcase(world.cardShowcase), error: "" }; }
    catch { return { config: { html: "", css: "" }, error: "The saved card showcase could not be read. Ask Studio to repair its HTML/CSS settings." }; }
  }, [world.cardShowcase]);
  function commit(field: keyof CardShowcaseData, value: string) {
    const current = useEditorStore.getState();
    if (current.readOnlyInspect || current.guestMode) return;
    try {
      setField("cardShowcase", updateCardShowcase(current.worldDraft.cardShowcase, { [field]: value }));
      setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to update the card showcase."); }
  }
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    <header className="shrink-0 border-b border-border bg-card px-6 py-4">
      <h1 className="text-[22px] font-bold tracking-tight text-foreground">Character showcase</h1>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Design the public profile for this story card with HTML and CSS. It appears on the card’s details page.</p>
    </header>
    <div className="min-w-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
      {(error || parsed.error) && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 p-3 text-xs text-destructive">{error || parsed.error}</p>}
      <div className="grid min-w-0 gap-6 pb-8 xl:grid-cols-2">
        <fieldset disabled={readOnly || !!parsed.error} className="min-w-0 space-y-5 disabled:opacity-60">
          <label className="block space-y-2 text-xs font-medium text-muted-foreground">Card content (HTML)
            <DebouncedTextarea aria-label="Card showcase HTML" value={parsed.config.html} onCommit={value => commit("html", value)} maxLength={CARD_SHOWCASE_HTML_LIMIT} spellCheck={false} placeholder={htmlExample} className={`${controlClass} min-h-[240px] resize-y`} />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">Leave HTML empty to use this card’s name, cover and description. Add public introductions, images and sections for a custom profile.</p>
          <label className="block space-y-2 text-xs font-medium text-muted-foreground">Card styles (CSS)
            <DebouncedTextarea aria-label="Card showcase CSS" value={parsed.config.css} onCommit={value => commit("css", value)} maxLength={CARD_SHOWCASE_CSS_LIMIT} spellCheck={false} placeholder={cssExample} className={`${controlClass} min-h-[280px] resize-y`} />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">Style <code>.card-showcase</code> and the classes in your HTML. Studio can update both fields. Save the card to keep your changes.</p>
        </fieldset>
        <section aria-label="Card profile preview" className="min-w-0 self-start overflow-hidden rounded-xl border border-border bg-card/40">
          <div className="border-b border-border px-4 py-3 text-xs font-medium text-muted-foreground">Card profile preview</div>
          <CardShowcase showcase={parsed.config} name={world.name} description={world.description} cover={cover} title="Card showcase preview" />
        </section>
      </div>
    </div>
  </div>;
}
