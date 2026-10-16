/** Data-only VN typography. Keep interfaces/vn/text-style.ts in sync. */
export const VN_TEXT_FONTS = [
  { id: "original", label: "Original VN", family: "VN,'DejaVu Sans','Noto Sans',sans-serif" },
  { id: "sans", label: "System sans", family: "system-ui,sans-serif" },
  { id: "serif", label: "System serif", family: "ui-serif,serif" },
  { id: "georgia", label: "Georgia", family: "Georgia,'Times New Roman',serif" },
  { id: "verdana", label: "Verdana", family: "Verdana,Geneva,sans-serif" },
  { id: "mono", label: "Monospace", family: "ui-monospace,monospace" },
] as const;
export type VnTextStyle = { font?: typeof VN_TEXT_FONTS[number]["id"]; color?: string; size?: number };
export type VnTextPreferences = { dialogue: VnTextStyle; narration: VnTextStyle };
export const VN_TEXT_DEFAULTS_FILE = "text-defaults.ts";

export function normalizeVnText(input: unknown): VnTextPreferences {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const result: VnTextPreferences = { dialogue: {}, narration: {} };
  for (const kind of ["dialogue", "narration"] as const) {
    const value = source[kind];
    if (!value || typeof value !== "object") continue;
    const style = value as Record<string, unknown>;
    if (VN_TEXT_FONTS.some(font => font.id === style.font)) result[kind].font = style.font as VnTextStyle["font"];
    if (typeof style.color === "string" && /^#[0-9a-f]{6}$/i.test(style.color)) result[kind].color = style.color.toLowerCase();
    if (typeof style.size === "number" && Number.isFinite(style.size) && style.size >= 14 && style.size <= 56) result[kind].size = Math.round(style.size);
  }
  return result;
}

export function resolveVnText(defaults: unknown, personal: unknown): VnTextPreferences {
  const card = normalizeVnText(defaults), user = normalizeVnText(personal);
  return { dialogue: { ...card.dialogue, ...user.dialogue }, narration: { ...card.narration, ...user.narration } };
}

export function vnTextCss(defaults: unknown, personal: unknown): string {
  const resolved = resolveVnText(defaults, personal);
  return (["dialogue", "narration"] as const).map(kind => {
    const style = resolved[kind];
    const font = VN_TEXT_FONTS.find(item => item.id === style.font);
    const declarations = [font && `font-family:${font.family}!important`, style.color && `color:${style.color}!important`, style.size && `font-size:${style.size}px!important;line-height:1.5!important`].filter(Boolean).join(";");
    if (!declarations) return "";
    const selector = kind === "dialogue" ? ".vn .vn-text:not(.vn-action),.vn .vn-log-copy" : ".vn .vn-text.vn-action,.vn .vn-narration";
    return `${selector}{${declarations}}`;
  }).join("");
}

/** Only parse our JSON data file; custom JavaScript must never be evaluated. */
export function readVnTextDefaults(source?: string): VnTextPreferences {
  if (!source) return normalizeVnText({});
  const match = source.match(/^\s*(?:\/\/[^\n]*\n\s*)*export\s+const\s+vnTextDefaults\s*=\s*([\s\S]*?);?\s*$/);
  try { if (match?.[1]) return normalizeVnText(JSON.parse(match[1])); } catch { /* custom source */ }
  throw new Error("VN text defaults use custom code. Edit text-defaults.ts in Advanced to keep that logic.");
}
export function writeVnTextDefaults(value: unknown): string {
  // Separate the keyword: the card compiler also scans strings for exports.
  return "// Creator defaults for VN reading text. Personal settings override these.\n" + "export" + ` const vnTextDefaults = ${JSON.stringify(normalizeVnText(value), null, 2)};\n`;
}
