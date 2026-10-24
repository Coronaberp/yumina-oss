import * as React from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { selectOptionsFromChildren, type SelectOption } from "./select-options";
export type { SelectOption } from "./select-options";

export interface SelectProps extends Pick<React.ComponentPropsWithoutRef<typeof DropdownMenuTrigger>, 'id' | 'aria-label' | 'aria-labelledby' | 'title'> {
  value: string | number;
  onValueChange: (value: string) => void;
  options?: SelectOption[];
  children?: React.ReactNode;
  compact?: boolean;
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  disabled?: boolean;
  /** Changes only the current view, so locked cards can still be browsed. */
  browseOnly?: boolean;
}

export function Select({
  value,
  onValueChange,
  options,
  children,
  compact = false,
  placeholder = "Select an option",
  className,
  triggerClassName,
  contentClassName,
  disabled,
  browseOnly = false,
  ...triggerProps
}: SelectProps) {
  const choices = options ?? selectOptionsFromChildren(children);
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement>();
  const captureTrigger = React.useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    const root = node.getRootNode();
    if (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot) {
      setPortalContainer(root.querySelector<HTMLElement>(".yumina-platform-overlay-surface") ?? node.parentElement ?? undefined);
    }
  }, []);
  const selectedValue = String(value);
  const selectedOption = choices.find((opt) => opt.value === selectedValue);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={captureTrigger}
        {...triggerProps}
        type="button"
        data-editor-control={browseOnly ? "browse" : "select"}
        disabled={disabled}
        className={cn(
          "group flex max-w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-border bg-card text-foreground shadow-inner transition-all hover:bg-accent focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50",
          compact ? "min-h-11 px-2 py-1 text-xs sm:min-h-8" : "w-full px-4 py-3 text-sm",
          triggerClassName,
          className
        )}
      >
        <span className="flex min-w-0 items-center gap-2 truncate text-left">
          {selectedOption ? (
            <>
              {selectedOption.icon && (
                <span className="shrink-0 text-muted-foreground">
                  {selectedOption.icon}
                </span>
              )}
              <span className="truncate">{selectedOption.label}</span>
            </>
          ) : (
            <span className="text-muted-foreground/50">{placeholder}</span>
          )}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        portalContainer={portalContainer}
        align="start"
        collisionPadding={12}
        className={cn("w-[var(--radix-dropdown-menu-trigger-width)] max-h-[min(300px,var(--radix-dropdown-menu-content-available-height))] max-w-[calc(100vw-24px)] overflow-y-auto min-w-[min(200px,calc(100vw-24px))] p-1.5 rounded-xl", contentClassName)}
      >
        {choices.map((opt, index) => (
          <React.Fragment key={opt.value}>
          {opt.group && opt.group !== choices[index - 1]?.group && <DropdownMenuLabel>{opt.group}</DropdownMenuLabel>}
          <DropdownMenuItem
            role="menuitemradio"
            aria-checked={selectedValue === opt.value}
            disabled={opt.disabled}
            onSelect={() => onValueChange(opt.value)}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2 outline-none transition-colors",
              "focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
              selectedValue === opt.value ? "bg-primary/5 text-primary" : "text-foreground"
            )}
          >
            {opt.icon && (
              <div className="mt-0.5 shrink-0 text-muted-foreground">
                {opt.icon}
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col whitespace-normal [overflow-wrap:anywhere]">
              <span className="text-sm font-medium">{opt.label}</span>
              {opt.description && (
                <span className="text-xs text-muted-foreground">
                  {opt.description}
                </span>
              )}
            </div>
            {selectedValue === opt.value && (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            )}
          </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
