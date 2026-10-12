import type { IDockviewPanelProps } from "dockview-react";
import { ComponentsSection } from "@/features/editor/sections/components";
import { CharacterShowcaseSection } from "@/features/editor/sections/character-showcase";
import { VnSpritesSection, VnBackgroundsSection } from "@/features/editor/sections/visual-novel";

export function CustomUiPanel(_props: IDockviewPanelProps) {
  return <div className="h-full min-w-0 overflow-auto bg-background p-4"><ComponentsSection /></div>;
}
export function CharacterShowcasePanel() {
  return <div className="h-full min-w-0 overflow-auto bg-background p-4"><CharacterShowcaseSection /></div>;
}
export function VnSpritesPanel(_props: IDockviewPanelProps) {
  return <div className="h-full min-w-0 overflow-auto bg-background p-4"><VnSpritesSection /></div>;
}
export function VnBackgroundsPanel(_props: IDockviewPanelProps) {
  return <div className="h-full min-w-0 overflow-auto bg-background p-4"><VnBackgroundsSection /></div>;
}
