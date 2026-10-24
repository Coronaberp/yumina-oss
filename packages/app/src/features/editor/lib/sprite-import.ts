/** Batch review stays separate from network uploads so a retry never loses work. */
export type SpriteImportItem = {
  id: string;
  file: File;
  emotion: string;
  replace: boolean;
  status: "queued" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
  assetRef?: string;
};
export type SpriteTargetSnapshot = {
  draftId: string;
  rootId: string;
  interfaceId: string;
  source: string;
  character: string;
  spriteType: string;
  spriteVariant?: string;
  ownerId?: string;
  serverWorldId?: string;
};
export function spriteTargetIsCurrent(snapshot: SpriteTargetSnapshot, current: Pick<SpriteTargetSnapshot, "draftId" | "rootId" | "interfaceId" | "source" | "spriteVariant" | "ownerId" | "serverWorldId"> | null, readOnly: boolean) {
  return !readOnly && !!current && snapshot.draftId === current.draftId && snapshot.rootId === current.rootId && snapshot.interfaceId === current.interfaceId && snapshot.source === current.source && (snapshot.spriteVariant ?? "") === (current.spriteVariant ?? "") && snapshot.ownerId === current.ownerId && snapshot.serverWorldId === current.serverWorldId;
}
export const spriteImageFile = (file: Pick<File, "name" | "type">) => /\.(png|jpe?g|webp|gif)$/i.test(file.name) && (!file.type || /^image\/(png|jpeg|webp|gif)$/.test(file.type));
const words = (text: string) => text.toLowerCase().replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function suggestSpriteEmotion(filename: string, emotions: Record<string, string>): string {
  const text = ` ${words(filename)} `;
  const matches = Object.entries(emotions).filter(([id, label]) => [words(id), words(label)].some(value => value && text.includes(` ${value} `)));
  return matches.length === 1 ? matches[0][0] : "";
}
export function spriteImportProblems(items: SpriteImportItem[], emotions: Record<string, string>, occupied: ReadonlySet<string>): Record<string, "image" | "emotion" | "duplicate" | "replace"> {
  const pending = items.filter(item => item.status !== "done");
  const problems: ReturnType<typeof spriteImportProblems> = {};
  for (const item of pending) {
    if (!spriteImageFile(item.file)) problems[item.id] = "image";
    else if (!Object.hasOwn(emotions, item.emotion)) problems[item.id] = "emotion";
    else if (pending.filter(other => other.emotion === item.emotion).length > 1) problems[item.id] = "duplicate";
    else if (occupied.has(item.emotion) && !item.replace) problems[item.id] = "replace";
  }
  return problems;
}
/** Each successful assignment commits immediately. Errors retain uploaded asset references for retry. */
export async function runSpriteImport(items: SpriteImportItem[], actions: {
  isCurrent: () => boolean;
  upload: (item: SpriteImportItem, progress: (value: number) => void) => Promise<string>;
  assign: (item: SpriteImportItem, assetRef: string) => void;
  update: (id: string, patch: Partial<SpriteImportItem>) => void;
  staleMessage: string;
}) {
  for (const item of items.filter(row => row.status !== "done")) {
    if (!actions.isCurrent()) {
      actions.update(item.id, { status: "error", error: actions.staleMessage });
      break;
    }
    let assetRef = item.assetRef;
    try {
      actions.update(item.id, { status: "uploading", error: undefined, progress: 0 });
      assetRef ??= await actions.upload(item, progress => actions.update(item.id, { progress }));
      actions.update(item.id, { assetRef });
      if (!actions.isCurrent()) throw new Error(actions.staleMessage);
      actions.assign(item, assetRef);
      actions.update(item.id, { status: "done", progress: 100, error: undefined });
    } catch (error) {
      actions.update(item.id, { status: "error", assetRef, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
