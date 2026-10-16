import { ChaptersSection } from "@/features/editor/sections/chapters";
import { ComponentsSection } from "@/features/editor/sections/components";
import { CharacterShowcaseSection } from "@/features/editor/sections/character-showcase";
import { VnSpritesSection, VnBackgroundsSection } from "@/features/editor/sections/visual-novel";

export function CustomUiPanel() {
  return <div className="h-full min-w-0 overflow-auto bg-background p-4"><ComponentsSection /></div>;
}
export function CharacterShowcasePanel() {
  return <div className="h-full min-w-0 overflow-auto bg-background p-4"><CharacterShowcaseSection /></div>;
}
export function VnSpritesPanel() {
  return <div className="h-full min-w-0 overflow-auto bg-background p-4"><VnSpritesSection /></div>;
}
export function VnBackgroundsPanel() {
  return <div className="h-full min-w-0 overflow-auto bg-background p-4"><VnBackgroundsSection /></div>;
}

export function ChaptersPanel() { return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background"><ChaptersSection compact /></div>; }
