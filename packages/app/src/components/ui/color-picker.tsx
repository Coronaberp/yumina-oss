import { useState, type ComponentPropsWithoutRef } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";
import { cn } from "@/lib/utils";

const colors = ["#e9e0cd", "#d4c292", "#ffffff", "#141312", "#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6", "#6366f1", "#a855f7", "#ec4899", "#78716c"];

interface ColorPickerProps extends Omit<ComponentPropsWithoutRef<"button">, "value" | "onChange"> {
  value: string;
  onValueChange: (color: string) => void;
}

/** An in-app palette and editable hex value; never opens an operating-system picker. */
export function ColorPicker({ value, onValueChange, className, ...props }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const valid = /^#[\da-f]{6}$/i.test(draft);
  return <DropdownMenu open={open} onOpenChange={next => { if (next) setDraft(value); setOpen(next); }}>
    <DropdownMenuTrigger {...props} type="button" data-editor-control="color" aria-label={props["aria-label"] ?? "Color"}
      className={cn("inline-flex h-10 w-14 shrink-0 items-center justify-center rounded-lg border border-border bg-card p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40", className)}>
      <span aria-hidden="true" className="h-full min-h-4 w-full rounded-sm border border-foreground/15" style={{ backgroundColor: value }} />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" collisionPadding={12} className="w-60 max-w-[calc(100vw-24px)] space-y-3 rounded-xl p-3">
      <div className="grid grid-cols-4 gap-2">
        {colors.map(color => <DropdownMenuItem key={color} role="menuitemradio" aria-label={color} aria-checked={color.toLowerCase() === value.toLowerCase()}
          onSelect={() => onValueChange(color)} className="h-9 justify-center rounded-md border border-border p-1">
          <span className="h-full w-full rounded-sm" style={{ backgroundColor: color }} />
        </DropdownMenuItem>)}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">Hex
        <input aria-label="Hex color" value={draft} maxLength={7} spellCheck={false} aria-invalid={!valid}
          className="min-h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          onChange={event => { const next = event.target.value; setDraft(next); if (/^#[\da-f]{6}$/i.test(next)) onValueChange(next); }}
          onKeyDown={event => { event.stopPropagation(); if (event.key === "Enter" && valid) { onValueChange(draft); setOpen(false); } if (event.key === "Escape") setOpen(false); }} />
      </label>
    </DropdownMenuContent>
  </DropdownMenu>;
}
