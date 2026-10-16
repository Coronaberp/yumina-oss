import {
  BookOpen,
  Cog,
  Image,
  LayoutGrid,
  Palette,
  MessageCircle,
  MessageSquare,
  Music,
  Users,
  Play,
  Variable,
  Zap as ZapIcon,
  type LucideIcon,
} from "lucide-react";
import type { DockviewApi } from "dockview-react";
import { isVnInterface, type RootComponent } from "@yumina/engine";

export const STUDIO_ADD_PAGE_PICKER_COMPONENT = "studio-add-page-picker";

export type StudioAddPagePickerParams = {
  openerGroupId: string;
};

export type StudioPanelMenuItem = {
  id: string;
  labelKey: string;
  icon: LucideIcon;
};

export const PANEL_MENU_GROUPS = [
  {
    labelKey: "studio.groups.story",
    items: [
      { id: "chapters", labelKey: "sections.chapters", icon: BookOpen },
      { id: "first-message", labelKey: "studio.panels.firstMessage", icon: MessageCircle },
      { id: "lorebook", labelKey: "studio.panels.lorebook", icon: BookOpen },
      { id: "variables", labelKey: "studio.panels.variables", icon: Variable },
      { id: "rules", labelKey: "studio.panels.behaviors", icon: ZapIcon },
    ],
  },
  {
    labelKey: "studio.groups.display",
    items: [
      { id: "custom-ui", labelKey: "sections.customUI", icon: LayoutGrid },
      { id: "audio", labelKey: "studio.panels.audio", icon: Music },
    ],
  },
  {
    labelKey: "shell.groups.visualNovel",
    items: [
      { id: "vn-sprites", labelKey: "sections.vnSprites", icon: Users },
      { id: "vn-backgrounds", labelKey: "sections.vnBackgrounds", icon: Image },
    ],
  },
  {
    labelKey: "shell.groups.publish",
    items: [
      { id: "character-showcase", labelKey: "sections.characterShowcase", icon: Palette },
    ],
  },
  {
    labelKey: "studio.groups.others",
    items: [
      { id: "overview", labelKey: "studio.panels.overview", icon: Cog },
      { id: "ai-chat", labelKey: "studio.panels.aiAssistant", icon: MessageSquare },
      { id: "playtest", labelKey: "studio.panels.playtest", icon: Play },
    ],
  },
] as const satisfies ReadonlyArray<{
  labelKey: string;
  items: ReadonlyArray<StudioPanelMenuItem>;
}>;

/** Match the available panels to the card's active interface, including legacy VN cards. */
export function getStudioPanelMenuGroups(root?: RootComponent) {
  const supportsVn = isVnInterface(root);
  return PANEL_MENU_GROUPS.map(group => ({
    ...group,
    items: group.items.filter(item => !item.id.startsWith("vn-") || supportsVn),
  })).filter(group => group.items.length > 0);
}

export function getAddPagePickerPanelId(groupId: string) {
  return `${STUDIO_ADD_PAGE_PICKER_COMPONENT}::${groupId}`;
}

/** Saved workspaces use the current editor sections when reopening old panels. */
export function migrateStudioPanelId(id: string): string {
  return ({ "code-view": "custom-ui", canvas: "custom-ui", assets: "vn-sprites", sidebar: "custom-ui" } as Record<string, string>)[id] ?? id;
}

function createPanelInstanceId(panelId: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${panelId}::${crypto.randomUUID()}`;
  }

  return `${panelId}::${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getActiveStudioGroup(containerApi: DockviewApi) {
  return containerApi.activeGroup ?? containerApi.activePanel?.group ?? containerApi.groups[0];
}

export function openAddPagePicker(options: {
  containerApi: DockviewApi;
  groupId: string;
  title: string;
}) {
  const targetGroupId = options.containerApi.getGroup(options.groupId)
    ? options.groupId
    : getActiveStudioGroup(options.containerApi)?.id;

  const pickerId = getAddPagePickerPanelId(targetGroupId ?? options.groupId);
  const existingPicker = options.containerApi.getPanel(pickerId);

  if (existingPicker && existingPicker.group.id === targetGroupId) {
    existingPicker.api.setTitle(options.title);
    existingPicker.api.setActive();
    return existingPicker;
  }

  if (targetGroupId) {
    return options.containerApi.addPanel<StudioAddPagePickerParams>({
      id: pickerId,
      component: STUDIO_ADD_PAGE_PICKER_COMPONENT,
      title: options.title,
      params: { openerGroupId: targetGroupId },
      position: { referenceGroup: targetGroupId, direction: "within" },
    });
  }

  return options.containerApi.addPanel<StudioAddPagePickerParams>({
    id: pickerId,
    component: STUDIO_ADD_PAGE_PICKER_COMPONENT,
    title: options.title,
    params: { openerGroupId: options.groupId },
  });
}

export function addStudioPanelInstance(options: {
  containerApi: DockviewApi;
  panelId: string;
  title: string;
  referenceGroupId: string;
  referencePanelId?: string;
}) {
  const instanceId = createPanelInstanceId(options.panelId);
  const referencePanel = options.referencePanelId
    ? options.containerApi.getPanel(options.referencePanelId)
    : undefined;

  if (referencePanel) {
    return options.containerApi.addPanel({
      id: instanceId,
      component: options.panelId,
      title: options.title,
      position: { referencePanel, direction: "within" },
    });
  }

  if (options.containerApi.getGroup(options.referenceGroupId)) {
    return options.containerApi.addPanel({
      id: instanceId,
      component: options.panelId,
      title: options.title,
      position: { referenceGroup: options.referenceGroupId, direction: "within" },
    });
  }

  return options.containerApi.addPanel({
    id: instanceId,
    component: options.panelId,
    title: options.title,
  });
}
