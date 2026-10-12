import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** Editable suggestions: unknown names and expressions remain valid input. */
export function AssetSuggestionInput({ label, value, onValueChange, options, maxLength, disabled }: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: string[];
  maxLength: number;
  disabled?: boolean;
}) {
  const { t } = useTranslation("editor");
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(-1);
  const filtered = [...new Set(options.filter(Boolean))].filter(option => option.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const expanded = open && !disabled;
  const active = filtered[highlighted];

  useEffect(() => {
    if (expanded && active) list.current?.children[highlighted]?.scrollIntoView({ block: "nearest" });
  }, [expanded, active, highlighted]);

  const show = () => { setQuery(""); setHighlighted(-1); setOpen(true); };
  const choose = (option: string) => { onValueChange(option.slice(0, maxLength)); setOpen(false); };

  return <div className="min-w-0 space-y-1.5">
    <label htmlFor={`${id}-input`} className="block text-xs font-medium text-muted-foreground">{label}</label>
    <div className="relative" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <input id={`${id}-input`} ref={input} role="combobox" aria-autocomplete="list" aria-expanded={expanded}
        aria-controls={expanded ? `${id}-list` : undefined} aria-activedescendant={expanded && active ? `${id}-option-${highlighted}` : undefined}
        autoComplete="off" maxLength={maxLength} value={value} disabled={disabled}
        onFocus={show} onClick={() => { if (!open) show(); }}
        onChange={event => { onValueChange(event.target.value); setQuery(event.target.value); setHighlighted(-1); setOpen(true); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
          else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); event.stopPropagation();
            if (!expanded) { show(); return; }
            setHighlighted(index => !filtered.length ? -1 : event.key === "ArrowDown" ? Math.min(index + 1, filtered.length - 1) : index < 0 ? filtered.length - 1 : Math.max(index - 1, 0));
          } else if (event.key === "Enter" && expanded) {
            event.preventDefault(); event.stopPropagation();
            if (active) choose(active); else setOpen(false);
          }
        }}
        className="min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 pr-10 text-sm text-foreground focus:border-primary focus:outline-none disabled:opacity-50 sm:min-h-0" />
      <button type="button" tabIndex={-1} disabled={disabled} aria-label={t("visualNovel.openOptions", { field: label })}
        onMouseDown={event => event.preventDefault()} onClick={() => { if (expanded) setOpen(false); else { input.current?.focus(); show(); } }}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground disabled:opacity-50">
        <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
      </button>
      {/* Five rows (36px desktop / 44px mobile), plus the menu border. */}
      {expanded && <div ref={list} id={`${id}-list`} role="listbox" aria-label={label}
        className="absolute inset-x-0 top-full z-40 mt-1 max-h-[222px] overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover px-1 text-popover-foreground shadow-xl sm:max-h-[182px]">
        {filtered.map((option, index) => <button key={option} id={`${id}-option-${index}`} type="button" role="option" aria-selected={value === option} tabIndex={-1}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(option)} onMouseMove={() => setHighlighted(index)}
          className={cn("flex h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent sm:h-9", highlighted === index && "bg-accent")}>
          <span className="min-w-0 flex-1 truncate" title={option}>{option}</span>{value === option && <Check className="h-4 w-4 shrink-0 text-primary" />}
        </button>)}
        {!filtered.length && <p className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">{t("visualNovel.customValueHint")}</p>}
      </div>}
    </div>
  </div>;
}
