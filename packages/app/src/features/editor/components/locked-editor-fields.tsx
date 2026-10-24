import { useEffect, useRef, type ReactNode } from "react";
import { Lock } from "lucide-react";

const fieldControl = '[role="switch"],[role="checkbox"],[role="radio"],[data-editor-control]:not([data-editor-control="browse"])';

/** Keep section/file navigation and text selection available on locked cards. */
export function LockedEditorFields({ locked, children }: { locked: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!locked || !root.current) return;
    const surface = root.current;
    const protect = () => {
      for (const input of surface.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea")) {
        if (input instanceof HTMLInputElement && input.type === "search") continue;
        if (input instanceof HTMLTextAreaElement || ["text", "number", "email", "url", "password"].includes(input.type)) input.readOnly = true;
        else if (input.type !== "hidden") input.disabled = true;
      }
      for (const select of surface.querySelectorAll<HTMLSelectElement>("select")) select.disabled = true;
      for (const control of surface.querySelectorAll<HTMLButtonElement>(`button:is(${fieldControl})`)) control.disabled = true;
      for (const node of surface.querySelectorAll<HTMLElement>('[contenteditable="true"]')) node.contentEditable = "false";
    };
    protect();
    const observer = new MutationObserver(protect);
    observer.observe(surface, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [locked]);
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col" data-locked-editor={locked || undefined}
      onPointerDownCapture={event => {
        if (locked && (event.target as HTMLElement).closest(fieldControl)) {
          event.preventDefault(); event.stopPropagation();
        }
      }}
      onClickCapture={event => {
        if (locked && (event.target as HTMLElement).closest(fieldControl)) {
          event.preventDefault(); event.stopPropagation();
        }
      }} onKeyDownCapture={event => {
        if (locked && [" ", "Enter", "ArrowDown", "ArrowUp"].includes(event.key) && (event.target as HTMLElement).closest(fieldControl)) {
          event.preventDefault(); event.stopPropagation();
        }
      }}>
      {locked && <div role="status" className="flex shrink-0 items-center gap-2 border-b border-primary/20 bg-primary/10 px-4 py-3 text-sm text-foreground">
        <Lock aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
        Locked card · Read-only. You can browse its sections and source files.
      </div>}
      {children}
    </div>
  );
}
