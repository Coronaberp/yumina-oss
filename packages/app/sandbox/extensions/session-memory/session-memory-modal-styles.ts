// Match the VN "Your choice" dialog inside the platform's isolated overlay.
// Shared by source interfaces and saved cards through SessionMemoryModal.
export const SESSION_MEMORY_MODAL_STYLES = `
.yumina-memory-dialog {
  --memory-gold: #c8b17e;
  --memory-cream: #eadfc9;
  --memory-border: #b69a6966;
  --color-white: var(--memory-cream);
  --color-primary: var(--memory-gold);
  --text-xs: 16px;
  --text-xs--line-height: 1.5;
  --text-sm: 18px;
  --text-sm--line-height: 1.5;
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: grid;
  place-items: center;
  padding: calc(72px + env(safe-area-inset-top, 0px)) 24px calc(24px + env(safe-area-inset-bottom, 0px));
  color: var(--memory-cream);
  font-family: 'DejaVu Sans', 'Noto Sans', sans-serif;
  font-size: 16px;
  line-height: 1.5;
}
.yumina-memory-dialog *, .yumina-memory-dialog *::before, .yumina-memory-dialog *::after { box-sizing: border-box; }
.yumina-memory-backdrop { position: absolute; inset: 0; background: rgba(28, 22, 17, .76); }
.yumina-memory-surface {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: min(620px, 100%);
  min-width: 0;
  max-height: calc(100dvh - 96px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  padding: 40px;
  overflow: hidden;
  background: linear-gradient(135deg, #30261c, #231c16);
  border: 1px solid var(--memory-border);
  border-radius: 8px;
  box-shadow: 0 16px 60px #0005;
}
.yumina-memory-header { flex: none; padding: 0 40px 24px 0; }
.yumina-memory-heading { display: flex; align-items: center; gap: 12px; }
.yumina-memory-heading > svg { width: 24px; height: 24px; flex: none; color: var(--memory-gold); stroke-width: 1.3; }
.yumina-memory-heading h2 { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; font-size: 28px; font-weight: 400; line-height: 1.4; }
.yumina-memory-tabs { flex: none; padding: 0 0 20px; }
.yumina-memory-tabs > div { display: flex; flex-wrap: wrap; gap: 8px; }
.yumina-memory-content { min-height: 0; min-width: 0; flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #b69a6966 transparent; }
.yumina-memory-footer { display: flex; flex: none; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding-top: 24px; }
.yumina-memory-surface button:not([role="checkbox"]):not([role="switch"]) {
  min-height: 44px;
  padding: 10px 14px;
  border: 1px solid var(--memory-border);
  border-radius: 4px;
  background: transparent;
  color: var(--memory-gold);
  font-family: inherit;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.4;
  cursor: pointer;
  white-space: normal;
}
.yumina-memory-surface button:not([role="checkbox"]):not([role="switch"]):hover:not(:disabled) { background: #ccaa671c; color: #f6e6c3; }
.yumina-memory-surface button[aria-pressed="true"], .yumina-memory-surface button[aria-selected="true"], .yumina-memory-surface button[class~="bg-primary"] { background: #ccaa6722; color: var(--memory-cream); }
.yumina-memory-surface button:disabled { opacity: .5; cursor: default; }
.yumina-memory-surface button[class*="text-red-"], .yumina-memory-surface [class*="text-red-"] { color: #efb8a6; }
.yumina-memory-surface input:not([type="checkbox"]), .yumina-memory-surface select, .yumina-memory-surface textarea {
  min-width: 0;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--memory-border);
  border-radius: 4px;
  background: #1b1510;
  color: var(--memory-cream);
  font-family: inherit;
  font-size: 16px;
  line-height: 1.5;
}
.yumina-memory-surface textarea { resize: vertical; }
.yumina-memory-surface input::placeholder, .yumina-memory-surface textarea::placeholder { color: #bfb097; opacity: .7; }
.yumina-memory-surface :is(button, input, select, textarea, summary):focus-visible { outline: 2px solid var(--memory-gold); outline-offset: 3px; box-shadow: none; }
.yumina-memory-content summary { min-height: 44px; padding-block: 10px; color: var(--memory-gold); }
.yumina-memory-content [class~="border"]:not([class*="border-red-"]) { border-color: #b69a694d; border-radius: 4px; }
.yumina-memory-surface [class~="text-[10px]"] { font-size: 12px; line-height: 1.5; }
.yumina-memory-surface [class~="text-[11px]"] { font-size: 13px; line-height: 1.5; }
.yumina-memory-surface .yumina-memory-close {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  background: none;
  color: #c7b58f;
}
.yumina-memory-close svg { width: 36px; height: 36px; stroke-width: 1.1; }
.yumina-memory-select { min-width: 0; }
.yumina-memory-surface .yumina-memory-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  background: #1b1510;
  color: var(--memory-cream);
  font-size: 16px;
  text-align: left;
}
.yumina-memory-select-trigger > span { min-width: 0; }
.yumina-memory-select-trigger > svg { width: 16px; height: 16px; flex: none; color: var(--memory-gold); transition: transform .15s ease; }
.yumina-memory-select-trigger[data-state="open"] > svg { transform: rotate(180deg); }
.yumina-memory-select-menu {
  z-index: 10001;
  width: var(--radix-dropdown-menu-trigger-width);
  max-width: calc(100vw - 48px);
  max-height: min(300px, var(--radix-dropdown-menu-content-available-height));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px;
  border: 1px solid var(--memory-border);
  border-radius: 4px;
  background: #261f18;
  color: var(--memory-cream);
  box-shadow: 0 8px 24px #0006;
  font-size: 16px;
  scrollbar-width: thin;
}
.yumina-memory-select-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 10px 12px; border-radius: 2px; outline: none; cursor: pointer; }
.yumina-memory-select-option[data-highlighted], .yumina-memory-select-option[data-state="checked"] { background: #ccaa6722; color: #f6e6c3; }
.yumina-memory-select-option[data-disabled] { opacity: .4; cursor: default; }
.yumina-memory-select-option svg { width: 16px; height: 16px; color: var(--memory-gold); }
@media (max-width: 600px) {
  .yumina-memory-surface { padding: 28px 20px; }
  .yumina-memory-heading h2 { font-size: 24px; }
  .yumina-memory-heading > svg { display: none; }
  .yumina-memory-header { padding-right: 28px; }
  .yumina-memory-content { overflow-wrap: anywhere; }
}
@media (max-height: 600px) {
  .yumina-memory-dialog { padding: calc(16px + env(safe-area-inset-top, 0px)) 24px calc(16px + env(safe-area-inset-bottom, 0px)); }
  .yumina-memory-surface { max-height: calc(100dvh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)); padding: 24px 20px; }
  .yumina-memory-header { padding-bottom: 16px; }
  .yumina-memory-heading h2 { font-size: 24px; }
  .yumina-memory-tabs { padding-bottom: 12px; }
}
`;
