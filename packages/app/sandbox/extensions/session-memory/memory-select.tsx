import { useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";

interface MemorySelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  label: string;
  disabled?: boolean;
  className?: string;
}

/** Keep the themed popup inside the Memory dialog's shadow and focus scope. */
export function MemorySelect({ value, onValueChange, options, label, disabled, className = "" }: MemorySelectProps) {
  const [open, setOpen] = useState(false);
  const portal = useRef<HTMLDivElement>(null);
  return (
    <div ref={portal} className={`yumina-memory-select ${className}`}>
      <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenu.Trigger type="button" disabled={disabled} aria-label={label} className="yumina-memory-select-trigger">
          <span>{options.find(option => option.value === value)?.label ?? value}</span>
          <ChevronDown aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={portal.current}>
          <DropdownMenu.Content data-memory-select-menu="true" className="yumina-memory-select-menu" align="start" sideOffset={4} collisionPadding={24} loop aria-label={label}>
            <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange}>
              {options.map(option => (
                <DropdownMenu.RadioItem key={option.value} value={option.value} disabled={option.disabled} className="yumina-memory-select-option">
                  <span>{option.label}</span>
                  <DropdownMenu.ItemIndicator><Check aria-hidden="true" /></DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
