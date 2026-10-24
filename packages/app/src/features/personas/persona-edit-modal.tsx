import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Camera, Save, Loader2, User, Plus, Trash2 } from "lucide-react";
import { personaEntriesSchema, personaSpriteExpressions, MAX_PERSONA_ENTRIES, MAX_PERSONA_ENTRY_TITLE, MAX_PERSONA_ENTRY_CONTENT, MAX_PERSONA_ENTRIES_TOTAL, type PersonaEntry, type PersonaSpriteExpression, type PersonaSprites } from "@yumina/shared";
import { ImageImportDialog, type ImageImportContext } from "@/components/image-import-dialog";
import { FieldError } from "@/components/ui/field-error";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { usePersonasStore, type Persona } from "@/stores/personas";
import { useUserAssetStore } from "@/stores/user-assets";
import { resolveImageUrl } from "@/lib/asset-url";

interface PersonaEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  persona?: Persona | null;
}

export function PersonaEditModal({ isOpen, onClose, persona }: PersonaEditModalProps) {
  const { t } = useTranslation("profile");
  const { createPersona, updatePersona } = usePersonasStore();
  const { uploadAsset } = useUserAssetStore();

  const [isSaving, setIsSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  // R4: this modal stays open on failure, so problems print inside it.
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [spriteError, setSpriteError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [sprites, setSprites] = useState<PersonaSprites>({});
  const [appearance, setAppearance] = useState("");
  const [personality, setPersonality] = useState("");
  const [backstory, setBackstory] = useState("");
  const [note, setNote] = useState("");
  const [entries, setEntries] = useState<(PersonaEntry & { key: string })[]>([]);
  const [uploadingSprite, setUploadingSprite] = useState<PersonaSpriteExpression | null>(null);

  const [imageImport, setImageImport] = useState<{ expression?: PersonaSpriteExpression; token: number; persona: Persona | null } | null>(null);
  const imageRequest = useRef(0);
  const personaScope = useRef(persona ?? null);
  personaScope.current = persona ?? null;
  const modalOpen = useRef(isOpen);
  modalOpen.current = isOpen;
  useEffect(() => () => { imageRequest.current++; }, []);

  useEffect(() => {
    imageRequest.current++;
    setImageImport(null);
    if (isOpen) {
      setName(persona?.name ?? "");
      setAvatarUrl(persona?.avatarUrl ?? null);
      setSprites(persona?.sprites ? { ...persona.sprites } : {});
      setAppearance(persona?.appearance ?? "");
      setPersonality(persona?.personality ?? "");
      setBackstory(persona?.backstory ?? "");
      setNote(persona?.note ?? "");
      setEntries((persona?.entries ?? []).map(entry => ({ ...entry, key: crypto.randomUUID() })));
      setIsSaving(false);
      setUploadingAvatar(false);
      setAvatarError(null);
      setSpriteError(null);
      setUploadingSprite(null);
      setFormError(null);
    }
  }, [isOpen, persona]);

  const handleImageUpload = async (files: File[], context: ImageImportContext, target: NonNullable<typeof imageImport>) => {
    const current = () => modalOpen.current && personaScope.current === target.persona && imageRequest.current === target.token && !context.signal.aborted;
    if (!current() || !files[0]) return;
    if (target.expression) { setUploadingSprite(target.expression); setSpriteError(null); }
    else { setUploadingAvatar(true); setAvatarError(null); }
    try {
      const asset = await uploadAsset(files[0], "image", undefined, { signal: context.signal, onProgress: context.onProgress, silent: true });
      if (!current()) return;
      if (!asset) throw new Error(t(target.expression ? "persona.modal.spriteUploadFailed" : "persona.modal.avatarUploadFailed"));
      if (target.expression) setSprites(value => ({ ...value, [target.expression!]: asset.url }));
      else setAvatarUrl(asset.url);
      setUploadingAvatar(false); setUploadingSprite(null); imageRequest.current++;
    } catch (failure) {
      if (!current()) return;
      const message = failure instanceof Error ? failure.message : t("persona.modal.avatarUploadFailed");
      if (target.expression) setSpriteError(message); else setAvatarError(message);
      throw failure;
    } finally {
      if (current()) { setUploadingAvatar(false); setUploadingSprite(null); }
    }
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;

    const parsedEntries = personaEntriesSchema.safeParse(
      entries.filter(entry => entry.title.trim() || entry.content.trim())
        .map(({ title, content }) => ({ title, content })),
    );
    if (!parsedEntries.success) {
      setFormError(t("persona.modal.entriesInvalid", { max: MAX_PERSONA_ENTRIES_TOTAL }));
      return;
    }

    setIsSaving(true);
    setFormError(null);
    try {
      const input = {
        name: trimmedName,
        avatarUrl: avatarUrl || null,
        appearance: appearance.trim() || null,
        personality: personality.trim() || null,
        backstory: backstory.trim() || null,
        sprites,
        note: note.trim() || null,
        entries: parsedEntries.data,
      };

      const result = persona
        ? await updatePersona(persona.id, input)
        : await createPersona(input);

      if (result) {
        // No pill: the modal closes onto the persona list, which now holds it.
        onClose();
      } else {
        setFormError(persona ? t("persona.modal.updateFailed") : t("persona.modal.createFailed"));
      }
    } catch {
      setFormError(persona ? t("persona.modal.updateFailed") : t("persona.modal.createFailed"));
    } finally {
      setIsSaving(false);
    }
  };

  const resolvedAvatar = resolveImageUrl(avatarUrl);
  const isEditing = !!persona;

  return (
    <>
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-vn-dialog-surface="structured" className="z-[120] flex max-h-[90dvh] max-w-2xl flex-col gap-0 overflow-hidden border-white/10 bg-[#1F1D21] p-0 text-main shadow-2xl shadow-gold/5 sm:rounded-3xl [&>button:last-child]:hidden">
        <DialogTitle className="sr-only">
          {isEditing ? t("persona.modal.editTitle") : t("persona.modal.createTitle")}
        </DialogTitle>

        {/* Header — matches EditProfileModal pattern */}
        <div data-vn-dialog-header="" className="relative flex shrink-0 items-center justify-between gap-3 overflow-hidden border-b border-white/5 bg-transparent p-4 sm:p-6">
          <div className="persona-editor-decoration absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gold/10 blur-3xl" />

          <div className="relative z-10 min-w-0">
            <h2 data-vn-dialog-title="" className="flex min-w-0 items-center gap-2 text-xl font-black text-main sm:text-2xl">
              <User className="h-5 w-5 shrink-0 text-gold" />
              <span className="truncate whitespace-nowrap">
                {isEditing ? t("persona.modal.editTitle") : t("persona.modal.createTitle")}
              </span>
            </h2>
            <p className="mt-1 text-xs text-sub">
              {t("persona.emptyDesc")}
            </p>
          </div>

          <div className="relative z-10 flex shrink-0 items-center gap-2 sm:gap-3">
            <Button
              onClick={onClose}
              variant="ghost"
              className="h-10 rounded-xl px-3 font-semibold sm:px-4 text-sub hover:bg-white/5 hover:text-main"
            >
              {t("action.cancel", { ns: "common" })}
            </Button>
            <Button
              onClick={handleSave}
              disabled={!name.trim() || isSaving || uploadingAvatar || uploadingSprite !== null}
              className="h-10 rounded-xl border border-gold/30 bg-gold/15 px-4 font-bold sm:px-6 text-gold transition-all hover:bg-gold/25 disabled:opacity-50"
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  {t("persona.modal.save")}
                </>
              )}
            </Button>
          </div>
        </div>

        {formError && (
          <div className="shrink-0 border-b border-white/5 px-6 pb-3">
            <FieldError message={formError} />
          </div>
        )}

        {/* Content */}
        <div data-vn-dialog-body="" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain bg-transparent p-8">
          <div className="relative z-10 space-y-8 animate-in fade-in duration-300">

            {/* Identity Section — Avatar + Name */}
            <section>
              <div className="persona-editor-card group relative overflow-hidden rounded-2xl border border-white/10 bg-[#2A272B]/50 p-6 transition-all hover:border-gold/30">
                <div className="relative z-10 flex flex-col items-center gap-6 md:flex-row md:items-start">
                  {/* Avatar */}
                  <div className="flex flex-col items-center gap-3">
                    <button
                      onClick={() => setImageImport({ token: ++imageRequest.current, persona: persona ?? null })}
                      disabled={uploadingAvatar}
                      className="group/avatar relative cursor-pointer"
                    >
                      <div className="relative h-28 w-28 overflow-hidden rounded-2xl border-2 border-white/10 shadow-lg transition-all group-hover/avatar:border-gold">
                        {resolvedAvatar ? (
                          <img
                            src={resolvedAvatar}
                            alt="Avatar"
                            className="h-full w-full object-cover transition-transform duration-500 group-hover/avatar:scale-105"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-gold/20 to-transparent">
                            <User className="h-10 w-10 text-gold/40" />
                          </div>
                        )}
                        <div className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl bg-black/60 opacity-0 backdrop-blur-sm transition-opacity group-hover/avatar:opacity-100">
                          {uploadingAvatar ? (
                            <Loader2 className="h-6 w-6 animate-spin text-white" />
                          ) : (
                            <>
                              <Camera className="mb-1 h-6 w-6 text-white" />
                              <span className="text-[10px] font-bold uppercase tracking-wider text-white">
                                {resolvedAvatar
                                  ? t("persona.modal.avatarChange")
                                  : t("persona.modal.avatarUpload")}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="absolute -bottom-2 -right-2 flex h-8 w-8 items-center justify-center rounded-full border-2 border-[#2A272B] bg-[#2A272B]">
                        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-gold text-black">
                          <Camera className="h-3 w-3" />
                        </div>
                      </div>
                    </button>
                    <FieldError message={avatarError} />
                  </div>

                  {/* Name + private note */}
                  <div className="flex-1 space-y-3 self-center md:self-start md:pt-2">
                    <label className="text-xs font-semibold uppercase tracking-wider text-sub">
                      {t("persona.modal.name")}
                    </label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t("persona.modal.namePlaceholder")}
                      className="h-12 rounded-xl border-white/10 bg-white/[0.05] px-4 text-white shadow-sm placeholder:text-sub/50 transition-all focus-visible:border-gold/50 focus-visible:ring-1 focus-visible:ring-gold/50"
                    />
                    <label className="block pt-1 text-xs font-semibold uppercase tracking-wider text-sub">
                      {t("persona.modal.note")}
                    </label>
                    <Input
                      value={note}
                      onChange={(e) => setNote(e.target.value.slice(0, 200))}
                      placeholder={t("persona.modal.notePlaceholder")}
                      className="h-10 rounded-xl border-white/10 bg-white/[0.05] px-4 text-white shadow-sm placeholder:text-sub/50 transition-all focus-visible:border-gold/50 focus-visible:ring-1 focus-visible:ring-gold/50"
                    />
                    <p className="text-[10px] leading-relaxed text-sub/50">
                      {t("persona.modal.noteHint")}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <hr className="border-white/5" />

            {/* Character Details Section */}
            <section>
              <div className="persona-editor-card group relative overflow-hidden rounded-2xl border border-white/10 bg-[#2A272B]/50 p-6 transition-all hover:border-gold/30">
                <div className="relative z-10 space-y-6">
                  {/* Appearance */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold uppercase tracking-wider text-sub">
                        {t("persona.modal.appearance")}
                      </label>
                      <span className="text-[10px] text-sub/40">{appearance.length}/1000</span>
                    </div>
                    <textarea
                      value={appearance}
                      onChange={(e) => setAppearance(e.target.value.slice(0, 1000))}
                      placeholder={t("persona.modal.appearancePlaceholder")}
                      className="min-h-[120px] w-full resize-none rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm leading-relaxed text-white shadow-sm placeholder:text-sub/50 transition-all focus-visible:border-gold/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/50"
                    />
                  </div>

                  {/* Personality */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold uppercase tracking-wider text-sub">
                        {t("persona.modal.personality")}
                      </label>
                      <span className="text-[10px] text-sub/40">{personality.length}/1000</span>
                    </div>
                    <textarea
                      value={personality}
                      onChange={(e) => setPersonality(e.target.value.slice(0, 1000))}
                      placeholder={t("persona.modal.personalityPlaceholder")}
                      className="min-h-[120px] w-full resize-none rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm leading-relaxed text-white shadow-sm placeholder:text-sub/50 transition-all focus-visible:border-gold/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/50"
                    />
                  </div>

                  {/* Backstory */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold uppercase tracking-wider text-sub">
                        {t("persona.modal.backstory")}
                      </label>
                      <span className="text-[10px] text-sub/40">{backstory.length}/2000</span>
                    </div>
                    <textarea
                      value={backstory}
                      onChange={(e) => setBackstory(e.target.value.slice(0, 2000))}
                      placeholder={t("persona.modal.backstoryPlaceholder")}
                      className="min-h-[120px] w-full resize-none rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm leading-relaxed text-white shadow-sm placeholder:text-sub/50 transition-all focus-visible:border-gold/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/50"
                    />
                  </div>
                  <section aria-label="VN stage sprites" className="space-y-3">
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-sub">{t("persona.modal.spriteExpressions")}</h3>
                      <p className="mt-1 text-xs leading-relaxed text-sub/70">{t("persona.modal.spriteExpressionsHint")}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {personaSpriteExpressions.map(expression => {
                        const label = expression[0]!.toUpperCase() + expression.slice(1);
                        const preview = resolveImageUrl(sprites[expression]);
                        return <article key={expression} className="overflow-hidden rounded-xl border border-white/10 bg-black/10">
                          <div className="flex h-36 items-center justify-center bg-black/15 p-2">
                            {preview ? <img src={preview} alt={`${label} sprite`} className="h-full max-w-full object-contain" /> : <User className="h-8 w-8 text-sub/30" />}
                          </div>
                          <div className="space-y-2 border-t border-white/5 p-2">
                            <p className="text-center text-xs font-semibold text-sub">{label}</p>
                            <Button type="button" variant="outline" aria-label={`Upload ${expression} sprite`} disabled={uploadingSprite !== null} onClick={() => setImageImport({ expression, token: ++imageRequest.current, persona: persona ?? null })} className="h-9 w-full px-2 text-xs">
                              {uploadingSprite === expression ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Camera className="mr-1 h-3.5 w-3.5" />}
                              {preview ? t("persona.modal.spriteReplace") : t("persona.modal.spriteUpload")}
                            </Button>
                            {preview && <Button type="button" variant="ghost" aria-label={`Remove ${expression} sprite`} disabled={uploadingSprite !== null} onClick={() => setSprites(current => { const next = { ...current }; delete next[expression]; return next; })} className="h-8 w-full px-2 text-xs text-sub hover:text-destructive">{t("persona.modal.spriteRemove")}</Button>}
                          </div>
                        </article>;
                      })}
                    </div>
                    <FieldError message={spriteError} />
                  </section>
                </div>
              </div>
            </section>

            <section aria-label={t("persona.modal.entriesTitle")}>
              {entries.length > 0 && (
                <div className="mb-4 space-y-3">
                  <div>
                    <h3 className="text-sm font-semibold text-main">{t("persona.modal.entriesTitle")}</h3>
                    <p className="mt-1 text-xs text-sub">{t("persona.modal.entriesHint")}</p>
                  </div>
                  {entries.map((entry, index) => (
                    <div key={entry.key} className="space-y-3 rounded-2xl border border-white/10 bg-[#2A272B]/50 p-4">
                      <div className="flex items-end gap-3">
                        <label className="min-w-0 flex-1 space-y-2">
                          <span className="text-xs font-semibold text-sub">{t("persona.modal.entryTitle")}</span>
                          <Input
                            value={entry.title}
                            maxLength={MAX_PERSONA_ENTRY_TITLE}
                            onChange={event => setEntries(current => current.map(item => item.key === entry.key ? { ...item, title: event.target.value } : item))}
                            placeholder={t("persona.modal.entryTitlePlaceholder")}
                            className="h-11 rounded-xl border-white/10 bg-white/[0.05] text-main focus-visible:border-gold/50 focus-visible:ring-gold/50"
                          />
                        </label>
                        <Button
                          type="button"
                          variant="ghost"
                          aria-label={t("persona.modal.removeEntry", { name: entry.title || index + 1 })}
                          onClick={() => setEntries(current => current.filter(item => item.key !== entry.key))}
                          className="h-11 rounded-xl px-3 text-sub hover:bg-white/5 hover:text-main"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <label className="block space-y-2">
                        <span className="text-xs font-semibold text-sub">{t("persona.modal.entryContent")}</span>
                        <textarea
                          value={entry.content}
                          maxLength={MAX_PERSONA_ENTRY_CONTENT}
                          onChange={event => setEntries(current => current.map(item => item.key === entry.key ? { ...item, content: event.target.value } : item))}
                          placeholder={t("persona.modal.entryContentPlaceholder")}
                          className="min-h-[120px] w-full resize-y rounded-xl border border-white/10 bg-white/[0.05] px-4 py-3 text-sm leading-relaxed text-main placeholder:text-sub/50 focus-visible:border-gold/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold/50"
                        />
                      </label>
                      <p className="text-right text-xs text-sub/60">{entry.content.length}/{MAX_PERSONA_ENTRY_CONTENT}</p>
                    </div>
                  ))}
                </div>
              )}
              <Button
                type="button"
                variant="ghost"
                disabled={entries.length >= MAX_PERSONA_ENTRIES}
                onClick={() => setEntries(current => [...current, { key: crypto.randomUUID(), title: "", content: "" }])}
                className="h-11 w-full rounded-xl border border-dashed border-white/15 text-gold hover:border-gold/40 hover:bg-gold/5"
              >
                <Plus className="mr-2 h-4 w-4" />
                {t("persona.modal.addEntry")}
              </Button>
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    {isOpen && imageImport && <ImageImportDialog preserveOriginal crop="none" maxBytes={Infinity}
      title={t(imageImport.expression ? "persona.modal.spriteUpload" : "persona.modal.avatarUpload")}
      onClose={() => { imageRequest.current++; setImageImport(null); setUploadingAvatar(false); setUploadingSprite(null); }}
      onImport={(files, context) => handleImageUpload(files, context, imageImport)} />}
    </>
  );
}
