import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";

export interface MemoryLoreMetadata {
  hidden?: boolean;
  metadata?: Record<string, string | string[]>;
  links?: Array<{ targetId: string; label: string }>;
  secrets?: string[];
}
export interface LoreMemoryFieldsProps {
  value?: MemoryLoreMetadata;
  onChange: (value: MemoryLoreMetadata) => void;
  entries: Array<{ id: string; name: string }>;
}
const fieldClass =
  "min-w-0 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

/** Authored lore details used by session memory. Parent owns persistence. */
export function LoreMemoryFields({
  value,
  onChange,
  entries,
}: LoreMemoryFieldsProps) {
  const { i18n } = useTranslation("editor");
  const zh = i18n.language.toLowerCase().startsWith("zh");
  const tt = (en: string, cn: string) => (zh ? cn : en);
  const id = useId();
  const [metadataDraft, setMetadataDraft] = useState<string | null>(null);
  const [metadataError, setMetadataError] = useState(false);
  const metadata = value?.metadata ?? {};
  const serialized = JSON.stringify(metadata, null, 2);
  const acceptedMetadata = useRef(serialized);
  useEffect(() => {
    if (serialized !== acceptedMetadata.current) {
      setMetadataDraft(null);
      setMetadataError(false);
    }
    acceptedMetadata.current = serialized;
  }, [serialized]);
  const availableEntries = entries.filter(
    (entry) => !value?.links?.some((link) => link.targetId === entry.id),
  );

  const change = (patch: Partial<MemoryLoreMetadata>) =>
    onChange({ ...value, ...patch });
  const updateLink = (
    index: number,
    patch: Partial<{ targetId: string; label: string }>,
  ) =>
    change({
      links: (value?.links ?? []).map((link, i) =>
        i === index ? { ...link, ...patch } : link,
      ),
    });
  const updateMetadata = (raw: string) => {
    setMetadataDraft(raw);
    try {
      const parsed: unknown = JSON.parse(raw || "{}");
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.values(parsed).some(
          (item) =>
            typeof item !== "string" &&
            !(
              Array.isArray(item) &&
              item.every((part) => typeof part === "string")
            ),
        )
      )
        throw new Error();
      setMetadataError(false);
      acceptedMetadata.current = JSON.stringify(parsed, null, 2);
      change({ metadata: parsed as Record<string, string | string[]> });
    } catch {
      setMetadataError(true);
    }
  };

  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card/40 p-4"
      aria-labelledby={`${id}-heading`}
    >
      <div>
        <h3
          id={`${id}-heading`}
          className="text-sm font-semibold text-foreground"
        >
          {tt("Story memory", "故事记忆")}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {tt(
            "Add details, relationships and hidden facts that can be remembered during play.",
            "添加游玩过程中可记住的细节、关联与隐藏事实。",
          )}
        </p>
      </div>
      <label className="flex items-start gap-2 text-sm text-foreground">
        <Checkbox

          checked={value?.hidden ?? false}
          onCheckedChange={(checked) => change({ hidden: (checked === true) })}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          {tt("Hidden lore", "隐藏设定")}
          <span className="mt-1 block text-xs text-muted-foreground">
            {tt(
              "Keep this entry out of ordinary recall until its details are revealed.",
              "在细节被揭示前，不将此条目用于普通回忆。",
            )}
          </span>
        </span>
      </label>
      <div className="space-y-1.5">
        <label
          htmlFor={`${id}-metadata`}
          className="text-xs font-medium text-muted-foreground"
        >
          {tt("Details", "细节")}
        </label>
        <textarea
          id={`${id}-metadata`}
          value={metadataDraft ?? serialized}
          onChange={(event) => updateMetadata(event.target.value)}
          onBlur={() => {
            if (!metadataError) setMetadataDraft(null);
          }}
          rows={4}
          spellCheck={false}
          className={`${fieldClass} font-mono text-xs`}
          aria-invalid={metadataError}
          aria-describedby={`${id}-metadata-help`}
        />
        <p
          id={`${id}-metadata-help`}
          className={`text-xs ${metadataError ? "text-destructive" : "text-muted-foreground"}`}
        >
          {metadataError
            ? tt(
                'Use an object with text values or lists of text, such as {"species": "elf"}.',
                '请使用包含文本值或文本列表的对象，例如 {"种族": "精灵"}。',
              )
            : tt(
                'Optional attributes, such as {"species": "elf", "skills": ["archery"]}.',
                '可选属性，例如 {"种族": "精灵", "技能": ["射箭"]}。',
              )}
        </p>
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">
            {tt("Related entries", "关联条目")}
          </h4>
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-primary disabled:opacity-40"
            disabled={!availableEntries.length}
            onClick={() =>
              change({
                links: [
                  ...(value?.links ?? []),
                  { targetId: availableEntries[0]!.id, label: "" },
                ],
              })
            }
          >
            <Plus className="size-3.5" />
            {tt("Add relation", "添加关联")}
          </button>
        </div>
        {(value?.links ?? []).map((link, index) => (
          <div
            key={index}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <Select compact
              value={link.targetId}
              onValueChange={(selectedValue) =>
                updateLink(index, { targetId: selectedValue })}
              aria-label={tt("Related entry", "关联条目")}
              className={fieldClass}
            >
              {!entries.some((entry) => entry.id === link.targetId) && (
                <option value={link.targetId}>
                  {tt("Entry unavailable", "条目不可用")}
                </option>
              )}
              {entries.map((entry) => (
                <option
                  key={entry.id}
                  value={entry.id}
                  disabled={value?.links?.some(
                    (other, otherIndex) =>
                      otherIndex !== index && other.targetId === entry.id,
                  )}
                >
                  {entry.name || tt("Untitled entry", "未命名条目")}
                </option>
              ))}
            </Select>
            <input
              value={link.label}
              maxLength={60}
              onChange={(event) =>
                updateLink(index, { label: event.target.value })
              }
              placeholder={tt(
                "Relationship, e.g. friend",
                "关联描述，例如朋友",
              )}
              aria-label={tt("Relationship label", "关联描述")}
              className={`${fieldClass} col-start-1 row-start-2 sm:col-start-auto sm:row-start-auto`}
            />
            <button
              type="button"
              onClick={() =>
                change({ links: value?.links?.filter((_, i) => i !== index) })
              }
              aria-label={tt("Remove relation", "移除关联")}
              className="col-start-2 row-start-1 rounded-lg px-2 text-muted-foreground hover:text-destructive focus-visible:ring-2 focus-visible:ring-primary sm:col-start-auto"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        {!entries.length && (
          <p className="text-xs text-muted-foreground">
            {tt(
              "Add another lore entry to link it here.",
              "添加其他设定条目后，可在此建立关联。",
            )}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <label
          htmlFor={`${id}-secrets`}
          className="text-xs font-medium text-muted-foreground"
        >
          {tt("Hidden details", "隐藏细节")}
        </label>
        <textarea
          id={`${id}-secrets`}
          value={(value?.secrets ?? []).join("\n")}
          onChange={(event) =>
            change({ secrets: event.target.value.split("\n") })
          }
          onBlur={(event) =>
            change({
              secrets: event.target.value
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            })
          }
          rows={4}
          className={fieldClass}
          aria-describedby={`${id}-secrets-help`}
          placeholder={tt(
            "One independent secret per line",
            "每行一个独立的秘密",
          )}
        />
        <p id={`${id}-secrets-help`} className="text-xs text-muted-foreground">
          {tt(
            "Write each fact so it can be revealed without giving away the others.",
            "每条事实应能独立揭示，避免同时泄露其他秘密。",
          )}
        </p>
      </div>
    </section>
  );
}
