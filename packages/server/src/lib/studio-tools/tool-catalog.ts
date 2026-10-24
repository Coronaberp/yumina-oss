import { z } from "zod";
import type { ChatMessage, ToolCall, ToolDefinition } from "../llm/types.js";

export const CORE_TOOL_NAMES = ["update_task_plan", "check_task_progress", "read_entities", "grep_world", "load_skill", "validate_world", "ask_user", "request_tools"] as const;
const core = new Set<string>(CORE_TOOL_NAMES);
export const TOOL_FAMILIES = [
  { name: "core", description: "Read, search, plan, ask and validate; always advertised.", tools: [...CORE_TOOL_NAMES] },
  { name: "content", description: "Character/lore/greeting entries, lorebooks and bindings.", tools: ["write_entry", "write_worldbook", "write_lore_binding", "delete_entities"] },
  { name: "mechanics", description: "Gameplay variables, structured values and event behaviors.", tools: ["write_variable", "write_behavior"] },
  { name: "settings", description: "Generation settings, player identity and authored naming profiles.", tools: ["update_settings"] },
  { name: "story", description: "Native chapters, scene events, routes and endings.", tools: ["write_chapter", "write_route", "write_ending"] },
  { name: "interface", description: "Custom interface files, official templates, status and public showcase.", tools: ["list_templates", "write_custom_ui", "edit_custom_ui", "write_status_visualization", "edit_status_visualization", "write_card_showcase", "write_character_showcase_css"] },
  { name: "assets", description: "Browse and inspect existing owned library images.", tools: ["list_assets", "view_image"] },
  { name: "vn_assets", description: "VN sprites, outfits, expressions, NPC pools and scene backgrounds.", tools: ["list_vn_assets", "edit_vn_assets"] },
  { name: "card_media", description: "Independent portrait card cover, page banner and framing.", tools: ["write_world_media"] },
  { name: "audio", description: "Music, sound effects and audio tracks.", tools: ["write_audio"] },
  { name: "naming", description: "Generate new fictional names and inspect creator naming profiles.", tools: ["generate_names", "list_name_profiles"] },
  { name: "image_import", description: "Image connection status and enabled artwork search/import.", tools: ["get_image_sources", "search_danbooru_images", "import_danbooru_image"] },
  { name: "image_generation", description: "Requested image generation and existing job status.", tools: ["generate_image", "generate_images", "get_image_job"] },
  { name: "audit", description: "Project completeness, dependencies, acceptance and cost diagnostics.", tools: ["audit_project_completeness", "get_visual_audit_inputs", "get_dependency_graph", "preflight_world", "set_acceptance_criteria", "check_acceptance_criteria", "analyze_token_cost"] },
  { name: "other", description: "Additional installed native capabilities.", tools: [] as string[] },
] as const;
const familyByName = new Map(TOOL_FAMILIES.map(family => [family.name as string, family]));
const primaryFamily = new Map(TOOL_FAMILIES.flatMap(family => family.tools.map(name => [name, family.name] as const)));
const dependencies: Record<string, readonly string[]> = {
  write_world_media: ["list_assets", "view_image"],
  edit_vn_assets: ["list_vn_assets", "list_assets", "view_image"],
  list_vn_assets: ["list_assets", "view_image"],
  write_audio: ["list_assets"],
  generate_image: ["get_image_sources", "get_image_job"],
  generate_images: ["get_image_sources", "get_image_job"],
  search_danbooru_images: ["get_image_sources"],
  import_danbooru_image: ["get_image_sources", "search_danbooru_images"],
};
export interface ToolSelectionState { version: 1; names: string[] }
export function readToolSelectionState(value: unknown): ToolSelectionState {
  const candidate = value && typeof value === "object" ? value as Partial<ToolSelectionState> : {};
  return { version: 1, names: candidate.version === 1 && Array.isArray(candidate.names)
    ? [...new Set(candidate.names.filter((name): name is string => typeof name === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(name)))].slice(0, 256) : [] };
}
export function isToolSelectionState(value: unknown): value is ToolSelectionState {
  return !!value && typeof value === "object" && (value as ToolSelectionState).version === 1
    && Array.isArray((value as ToolSelectionState).names);
}

/** Only unfinished calls and the latest failed attempt need retry schemas. */
export function pinnedStudioToolNames(messages: readonly ChatMessage[], pending: readonly ToolCall[] = [], checkpoint: readonly ToolCall[] = []) {
  const unresolved = new Map([...pending, ...checkpoint].map(call => [call.id, call.function.name])), failed = new Set<string>(), completed = new Set<string>();
  const hasError = (value: unknown): boolean => Array.isArray(value) ? value.some(hasError)
    : !!value && typeof value === "object" && (!!(value as Record<string, unknown>).error
      || ["error", "partial"].includes(String((value as Record<string, unknown>).status)));
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) unresolved.set(call.id, call.function.name);
    if (message.role !== "tool") continue;
    const name = unresolved.get(message.tool_call_id);
    completed.add(message.tool_call_id);
    if (!name) continue;
    unresolved.delete(message.tool_call_id);
    let error = false;
    try { error = hasError(typeof message.content === "string" ? JSON.parse(message.content) : message.content); } catch { /* Plain successful tool text. */ }
    if (error) failed.add(name); else failed.delete(name);
  }
  return [...new Set([...unresolved.values(), ...failed, ...pending.filter(call => !completed.has(call.id)).map(call => call.function.name), ...checkpoint.map(call => call.function.name)])];
}
function expandNames(names: readonly string[], available: Set<string>) {
  const expanded = new Set<string>();
  const visit = (name: string) => {
    if (!available.has(name) || expanded.has(name)) return;
    expanded.add(name);
    for (const dependency of dependencies[name] ?? []) visit(dependency);
  };
  names.forEach(visit);
  return expanded;
}
export function selectStudioTools(availableTools: readonly ToolDefinition[], state: ToolSelectionState,
  options: { mode?: "normal" | "summary" | "naming"; pinnedNames?: readonly string[] } = {}): ToolDefinition[] {
  if (options.mode === "summary") return [];
  if (options.mode === "naming") return availableTools.filter(tool => tool.function.name === "generate_names");
  const available = new Set(availableTools.map(tool => tool.function.name));
  const selected = expandNames([...CORE_TOOL_NAMES, ...state.names, ...(options.pinnedNames ?? [])], available);
  return [...availableTools.filter(tool => core.has(tool.function.name) && selected.has(tool.function.name)),
    ...availableTools.filter(tool => !core.has(tool.function.name) && selected.has(tool.function.name))];
}

const requestSchema = z.object({
  browse: z.enum(["families", "tools"]).default("families"), query: z.string().max(120).optional(),
  offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(10).default(10),
  names: z.array(z.string().min(1).max(100)).max(8).optional(),
  families: z.array(z.string().min(1).max(100)).max(3).optional(), replace: z.boolean().optional(),
}).strict();
export const REQUEST_TOOLS_TOOL: ToolDefinition = { type: "function", function: {
  name: "request_tools", description: "Browse the paged native tool catalog or activate specialist tools for the next model call. Omit names/families to browse without changing selection. Search query matches names and descriptions. Explicit names/families activate existing available tools with needed readers; replace=true replaces optional selection while pending/retry tools remain pinned. This does not edit the card or enable unavailable features. Follow nextOffset until null.",
  parameters: { type: "object", additionalProperties: false, properties: {
    browse: { type: "string", enum: ["families", "tools"] }, query: { type: "string", maxLength: 120 },
    offset: { type: "integer", minimum: 0, maximum: 10000 }, limit: { type: "integer", minimum: 1, maximum: 10 },
    names: { type: "array", maxItems: 8, items: { type: "string", maxLength: 100 } },
    families: { type: "array", maxItems: 3, items: { type: "string", maxLength: 100 } }, replace: { type: "boolean" },
  } },
} };
export interface ToolCatalogItem { kind: "family" | "tool"; name: string; description: string; family?: string; tools?: string[] }
export function requestStudioTools(input: unknown, availableTools: readonly ToolDefinition[], state: ToolSelectionState) {
  const request = requestSchema.parse(input);
  const available = new Set(availableTools.map(tool => tool.function.name));
  const requestedNames = [...(request.names ?? [])];
  for (const name of requestedNames) if (!available.has(name)) throw new Error(`Tool ${name} is unknown or unavailable. Browse request_tools for available capabilities.`);
  const unavailableTools: string[] = [];
  for (const name of request.families ?? []) {
    const family = familyByName.get(name);
    if (!family) throw new Error(`Unknown tool family ${name}. Browse request_tools and follow nextOffset.`);
    const members = name === "other" ? availableTools.map(tool => tool.function.name).filter(tool => !primaryFamily.has(tool)) : family.tools;
    for (const tool of members) { if (available.has(tool)) requestedNames.push(tool); else unavailableTools.push(tool); }
  }
  const mutating = request.names !== undefined || request.families !== undefined;
  const nextState = mutating ? { version: 1 as const, names: [...expandNames([
    ...(request.replace ? [] : state.names), ...requestedNames,
  ], available)].filter(name => !core.has(name)) } : readToolSelectionState(state);
  const query = request.query?.trim().toLowerCase() ?? "";
  const items: ToolCatalogItem[] = request.browse === "tools"
    ? availableTools.map(tool => ({ kind: "tool" as const, name: tool.function.name, family: primaryFamily.get(tool.function.name) ?? "other", description: tool.function.description.slice(0, 200) }))
    : TOOL_FAMILIES.map(family => ({ kind: "family" as const, name: family.name, description: family.description,
      tools: availableTools.map(tool => tool.function.name).filter(name => (primaryFamily.get(name) ?? "other") === family.name) })).filter(family => family.tools.length > 0);
  const filtered = items.filter(item => !query || [item.name, item.description, item.family ?? "", ...(item.tools ?? [])].some(value => value.toLowerCase().includes(query)));
  const page = filtered.slice(request.offset, request.offset + request.limit);
  const nextOffset = request.offset + page.length < filtered.length ? request.offset + page.length : null;
  return { state: nextState, result: {
    items: page, total: filtered.length, offset: request.offset, nextOffset, hasMore: nextOffset !== null,
    activeNames: selectStudioTools(availableTools, nextState).map(tool => tool.function.name),
    ...(unavailableTools.length ? { unavailableTools: [...new Set(unavailableTools)] } : {}),
    help: "Catalog reads do not change the card. Activate names or families for their schemas on the next model call; load the relevant skill before writing. Follow nextOffset to discover more. Use replace=true with explicit names/families when optional tools are no longer needed.",
  } };
}

/** Hints reduce the first request; explicit discovery remains available in every normal mode. */
export function seedStudioToolSelection(availableTools: readonly ToolDefinition[], hints: { activePanel?: string; userMessage?: string }, state?: ToolSelectionState) {
  if (state !== undefined) return readToolSelectionState(state);
  const text = hints.userMessage ?? "";
  const matches: Array<[string, RegExp]> = [
    ["card_media", /\b(cover|banner|thumbnail|card art)\b/i],
    ["vn_assets", /\b(sprite|outfit|wardrobe|emotion|background image|scene image)\b/i],
    ["image_generation", /\b(generate|draw|create)\b.{0,35}\b(image|artwork|picture|illustration)\b/i],
    ["image_import", /\b(danbooru|import artwork)\b/i],
    ["audio", /\b(audio|music|bgm|sfx|soundtrack)\b/i],
    ["mechanics", /\b(variable|behavior|reaction|health|counter|game mechanic)\b/i],
    ["story", /\b(chapter|route|ending|scene event)\b/i],
    ["interface", /\b(tsx|jsx|custom ui|showcase|layout|theme|visualization|css)\b/i],
    ["interface", /\b(?:official|vn|visual novel)\s+(?:[a-z]+\s+){0,2}templates?\b/i],
    ["content", /\b(character entry|lorebook|worldbook|greeting|lore entry)\b/i],
    ["naming", /\b(generate names|new names|naming profile)\b/i],
  ];
  const explicitNames = availableTools.filter(tool => text.includes(tool.function.name)).map(tool => tool.function.name).slice(0, 8);
  const families = [...new Set(matches.filter(([, pattern]) => pattern.test(text)).map(([family]) => family))].slice(0, 3);
  const panelFamily: Record<string, string> = { overview: "card_media", sprites: "vn_assets", "visual-novel": "vn_assets", variables: "mechanics", rules: "mechanics", audio: "audio", "code-view": "interface", canvas: "interface", lorebook: "content", entries: "content", chapters: "story" };
  if (!families.length && !explicitNames.length && hints.activePanel && panelFamily[hints.activePanel]) families.push(panelFamily[hints.activePanel]!);
  return requestStudioTools({ names: explicitNames, families }, availableTools, { version: 1, names: [] }).state;
}

export function skillNamesForTools(toolNames: readonly string[]) {
  const set = new Set(toolNames), skills = new Set<string>();
  if (set.has("write_entry")) skills.add("entries");
  if (set.has("write_worldbook") || set.has("write_lore_binding")) skills.add("lore");
  if (set.has("write_variable")) skills.add("variables");
  if (set.has("write_behavior")) skills.add("rules");
  if (["write_chapter", "write_route", "write_ending"].some(name => set.has(name))) skills.add("world-design");
  if (["write_custom_ui", "edit_custom_ui", "write_status_visualization", "edit_status_visualization"].some(name => set.has(name))) { skills.add("tsx"); skills.add("front-ui"); }
  if (set.has("write_audio")) skills.add("audio");
  return [...skills];
}
export function contextNeedsForTools(toolNames: readonly string[]) {
  const set = new Set(toolNames);
  return {
    includeAssetInventory: ["list_assets", "view_image", "write_audio", "generate_image", "generate_images"].some(name => set.has(name)),
    includeMediaInventory: set.has("write_world_media"),
  };
}
const familyGuides: Record<string, string> = {
  content: "Read existing entries first, reuse IDs and preserve omitted fields. Set role=character for character profiles. Character portraits belong to write_entry.portrait, not card cover metadata. Keep scene presentation outside <variable-updates>; no-change state rules must not suppress scenes.",
  mechanics: "Use typed variable values and native behaviors. Preserve existing defaults and metadata when omitted; supplied arrays replace their entire list. Read the variables/rules skill before writing.",
  settings: "Read settings first and update only requested fields. Naming profiles must be creator-authored. Disabling storyStructureEnabled preserves story definitions and progress.",
  story: "Chapters, scene events, routes and endings are native authoring data in every interface. Preserve stable IDs and unrelated scenes, conditions and effects; read world-design before changes.",
  interface: "Read the mounted source and relevant manual first. Prefer targeted edit_custom_ui patches; adding a file alone does not mount it. Use official templates only after list_templates reads their source. Static validation does not prove rendered visibility.",
  assets: "Follow list_assets pagination before declaring art missing. Inspect actual pixels with view_image before visual claims; keep owned @asset refs and never invent paths or external URLs.",
  vn_assets: "Read list_vn_assets for exact character/type/emotion/outfit/opening IDs and scene IDs before edit_vn_assets. Emit arrival-only [SCENE:configured-id] on arrival at that configured scene; scene presentation is independent of variable state updates. Preserve native scene IDs, period assignments and custom source. Dialogue uses [SPEAKER:Exact Name:emotion:type:variant]; omitted type preserves the current outfit and variant, explicit type without variant selects its base, and unknown outfits preserve the last valid selection. NPC metadata uses [SPEAKER:NPC:normal:male:stable-id], whose fourth/fifth fields remain gender/identity. Use only available outfit art and expressions; never substitute an NPC image or another outfit for a named character.",
  card_media: "Read world-media with read_entities before write_world_media. portraitAssetRef and bannerAssetRef are independent owned @asset:UUID refs; null clears only that image. Omitting the whole crop field preserves framing; supplied crop objects replace it, so carry forward other x/y/zoom/fit values when changing one coordinate. Null crop resets framing. Banners use 16:5 and default contain; portrait display uses the actual thumbnailUrl, never deprecated avatar. A legacy thumbnailUrl or storage key is not an owned @asset reference; never invent one from it.",
  audio: "Use write_audio with registered asset refs. Preserve unrelated tracks and settings; load audio instructions before writing.",
  naming: "Use generate_names for every new fictional name; list_name_profiles exposes creator styles. Preserve existing names and do not invent fragment overrides.",
  image_import: "Check get_image_sources before enabled artwork search/import. Import existing artwork separately from generation, then assign its owned reference with the relevant native tool.",
  image_generation: "Generate only requested artwork. Check image connections and follow model/content-rating restrictions; existing assets need no generation. Jobs are cancellable and asynchronous: continue independent work, inspect status only when needed, and never claim completion before a saved result.",
  audit: "Choose the targeted audit for the actual question. Acceptance checks and static validation are source evidence; they do not establish rendered visibility or image appearance.",
};
export function buildToolSelectionInstructions(toolNames: readonly string[]) {
  const families = [...new Set(toolNames.map(name => primaryFamily.get(name)).filter((name): name is NonNullable<typeof name> => !!name && name !== "core"))];
  return `<tools-guide>\nOnly the currently advertised tool schemas are loaded. Use request_tools to browse paged families/tools or activate missing names; no keyword or panel restricts discovery. Their schemas appear on the next model call. Load the relevant skill before writing.\nUse actual function calls and claim completion only after a successful tool result. A standalone JSON tool envelope can execute: explain examples in prose or wrap them in an example object.\nNew fictional names MUST come from generate_names; request that tool before suggesting names. Preserve supplied names and never invent a fallback.\nCall ask_user alone for essential decisions. Follow-up instructions steer the same task; /summarize is not authorization to edit.\nWrites apply individually. Preserve successful changes and retry only failed calls, reuse stable IDs and supply only changed fields. Preserve authored content and stable owned asset refs; never embed base64 or invent asset URLs. validate_world does not prove rendered visibility.\n${families.map(family => familyGuides[family] ?? "").filter(Boolean).join("\n")}\n</tools-guide>`;
}
