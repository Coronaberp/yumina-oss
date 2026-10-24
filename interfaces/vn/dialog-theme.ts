/** Shared by saved VN cards, host dialogs and the isolated platform overlay. */
export const vnDialogTheme = `
[data-yumina-dialog-theme="vn"] {
  --vn-dialog-gold: #c8b17e;
  --vn-dialog-cream: #eadfc9;
  --vn-dialog-border: #b69a6966;
  --color-gold: var(--vn-dialog-gold);
  --color-primary: var(--vn-dialog-gold);
  --color-main: var(--vn-dialog-cream);
  --color-foreground: var(--vn-dialog-cream);
  --color-card-foreground: var(--vn-dialog-cream);
  --color-sub: #bfb097;
  --color-muted-foreground: #bfb097;
  --color-card: #261f18;
  --color-popover: #261f18;
  --color-border: var(--vn-dialog-border);
}
:where([data-yumina-dialog-theme="vn"]) :is([data-vn-dialog-backdrop], .vn-character-backdrop) {
  background: rgba(28, 22, 17, .76);
  backdrop-filter: none;
}
:where([data-yumina-dialog-theme="vn"]) :is([data-vn-dialog-surface], .vn-composer-card, .vn-character-card) {
  background: linear-gradient(135deg, #30261c, #231c16);
  color: var(--vn-dialog-cream);
  border: 1px solid var(--vn-dialog-border);
  border-radius: 8px;
  box-shadow: 0 16px 60px #0005;
  font-family: 'DejaVu Sans', 'Noto Sans', sans-serif;
  font-size: 16px;
  line-height: 1.5;
  backdrop-filter: none;
  max-height: calc(100dvh - 96px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  min-width: 0;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: #b69a6966 transparent;
}
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface="plain"] {
  width: min(620px, calc(100vw - 48px));
  max-width: 620px;
  padding: 40px;
}
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-kind="model"] { width: min(620px, calc(100vw - 32px)); max-width: 620px; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface="compact"] { padding: 16px; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-header] { padding: 40px 40px 24px; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-body] { padding: 0 40px 24px; min-width: 0; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-footer] { padding: 16px 40px 24px; }
:where([data-yumina-dialog-theme="vn"]) :is([data-vn-dialog-title], .vn-character-card h1) {
  font-family: inherit;
  font-size: 28px;
  font-weight: 400;
  line-height: 1.4;
  letter-spacing: normal;
  color: var(--vn-dialog-cream);
}
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] :is(.text-xs, .text-sm):not([data-vn-dialog-title]) { font-size: 16px; line-height: 1.5; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] :is([class~="text-[10px]"], [class~="text-[11px]"]) { font-size: 12px; line-height: 1.5; }
:where([data-yumina-dialog-theme="vn"]) :is([data-vn-dialog-surface], .vn-composer-card, .vn-character-card) button:not([role="checkbox"]):not([role="switch"]):not([role="radio"]) {
  min-height: 44px;
  padding: 10px 14px;
  border: 1px solid var(--vn-dialog-border);
  border-radius: 4px;
  background: transparent;
  color: var(--vn-dialog-gold);
  font-family: inherit;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.4;
  white-space: normal;
  flex-shrink: 0;
}
:where([data-yumina-dialog-theme="vn"]) :is([data-vn-dialog-surface], .vn-composer-card, .vn-character-card) button:not([role="checkbox"]):not([role="switch"]):not([role="radio"]):hover:not(:disabled) { background: #ccaa671c; color: #f6e6c3; }
:where([data-yumina-dialog-theme="vn"]) :is([data-vn-dialog-surface], .vn-composer-card, .vn-character-card) button:is([aria-pressed="true"], [aria-selected="true"], [class~="bg-primary"]) { background: #ccaa6722; color: var(--vn-dialog-cream); }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] button:disabled { opacity: .5; cursor: default; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] :is(button[class*="text-red-"], [class*="text-red-"]) { color: #efb8a6; }
:where([data-yumina-dialog-theme="vn"]) :is([data-vn-dialog-surface], .vn-composer-card, .vn-character-card) :is(input:not([type="checkbox"]):not([type="file"]):not([type="range"]):not([type="radio"]), select, textarea) {
  min-width: 0;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--vn-dialog-border);
  border-radius: 4px;
  background: #1b1510;
  color: var(--vn-dialog-cream);
  font-family: inherit;
  font-size: 16px;
  line-height: 1.5;
}
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] input:is([class~="pl-8"], [class~="pl-9"], [class~="pl-10"]) { padding-left: 40px; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] button:is([class~="w-6"], [class~="w-7"], [class~="w-8"]) { width: 44px; height: 44px; padding: 0; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] button > svg { flex-shrink: 0; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] :is(input, textarea)::placeholder { color: #bfb097; opacity: .7; }
:where([data-yumina-dialog-theme="vn"]) :is([data-vn-dialog-surface], .vn-composer-card, .vn-character-card) :is(button, input, select, textarea, summary):focus-visible { outline: 2px solid var(--vn-dialog-gold); outline-offset: 3px; box-shadow: none; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] [class~="border"]:not([class*="border-red-"]):not([class*="border-destructive"]) { border-color: #b69a694d; border-radius: 4px; }
:where([data-yumina-dialog-theme="vn"]) :is([data-vn-dialog-surface], .vn-composer-card, .vn-character-card) :is([data-vn-dialog-close], .vn-character-close, .vn-close) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  min-width: 44px;
  padding: 0;
  margin: 0;
  border: 0;
  background: none;
  color: #c7b58f;
}
:where([data-yumina-dialog-theme="vn"]) :is([data-vn-dialog-close], .vn-character-close, .vn-composer-card .vn-close) svg { width: 36px; height: 36px; stroke-width: 1.1; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-title] > svg { width: 24px; height: 24px; color: var(--vn-dialog-gold); stroke-width: 1.3; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .profile-overview-glass {
  background: #1b151040;
  border: 1px solid #b69a694d;
  border-radius: 4px;
  box-shadow: none;
  backdrop-filter: none;
}
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .profile-overview-glass > .absolute { display: none; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-carousel-card {
  padding: 20px 16px;
  border: 1px solid #b69a694d;
  border-radius: 4px;
  background: transparent;
  box-shadow: none;
}
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-carousel-card[data-active="true"] { border-color: var(--vn-dialog-gold); background: #ccaa6715; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-carousel-selection { border: 0; padding: 0; background: none; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-carousel-selection:is([aria-pressed="true"], :hover:not(:disabled)) { background: none; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-carousel-actions button { width: 44px; height: 44px; padding: 0; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-carousel-arrow { width: 44px; height: 44px; padding: 0; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-carousel-pagination { gap: 0; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-carousel-dot, :where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-carousel-dot:hover:not(:disabled) { display: grid; place-items: center; width: 28px; height: 44px; border: 0; padding: 0; background: none; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-carousel-dot::after { content: ''; width: 7px; height: 7px; border-radius: 4px; background: #bfb09766; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-carousel-dot[aria-current="true"]::after { width: 14px; background: var(--vn-dialog-gold); }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-editor-decoration { display: none; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-editor-card { background: #1b151040; }
:where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-header] { flex-wrap: wrap; gap: 16px; }
@media (max-width: 600px) {
  :where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface] .persona-carousel-center { width: 160px; }
  :where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface="plain"] { padding: 28px 20px; width: calc(100vw - 32px); }
  :where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-header] { padding: 28px 20px 20px; }
  :where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-body] { padding: 0 20px 20px; }
  :where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-footer] { padding: 16px 20px 20px; }
  :where([data-yumina-dialog-theme="vn"]) :is([data-vn-dialog-title], .vn-character-card h1) { font-size: 24px; }
}
@media (max-height: 600px) {
  :where([data-yumina-dialog-theme="vn"]) :is([data-vn-dialog-surface], .vn-composer-card, .vn-character-card) { max-height: calc(100dvh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)); }
  :where([data-yumina-dialog-theme="vn"]) [data-vn-dialog-surface="plain"] { padding: 24px 20px; }
}
`;
