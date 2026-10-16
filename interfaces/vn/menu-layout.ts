/** The close control belongs to the overlay, outside the scrolling drawer. */
export const vnMenuLayout = `
.vn .vn-menu-overlay>.vn-menu-close{position:absolute;top:calc(18px + env(safe-area-inset-top));right:28px;z-index:5;min-width:44px;height:44px;padding:0 8px;background:#30261c;border-radius:6px}
.vn .vn-menu-overlay>.vn-drawer{padding-top:calc(88px + env(safe-area-inset-top))}
.vn .vn-menu-overlay .vn-brand{white-space:normal;overflow-wrap:anywhere;max-width:100%;flex-shrink:0}
@media(max-width:600px){.vn .vn-menu-overlay>.vn-menu-close{right:20px}}
`;
