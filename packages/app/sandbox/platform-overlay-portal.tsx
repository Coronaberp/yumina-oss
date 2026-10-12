import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { initializeSandboxPlatformOverlay } from "./platform-overlay-root";
import { useYumina } from "./sandbox-context";
import { vnDialogTheme } from "../../../interfaces/vn/dialog-theme";

export function SandboxPlatformOverlay({ children }: { children: ReactNode }) {
  const mount = initializeSandboxPlatformOverlay();
  const { dialogTheme } = useYumina();
  return createPortal(
    <div className="yumina-platform-overlay-surface" data-yumina-dialog-theme={dialogTheme}>
      <style>{vnDialogTheme}</style>
      {children}
    </div>,
    mount,
  );
}
