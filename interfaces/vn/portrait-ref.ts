/** Thumbnails are for the log's small avatars; sprites keep their exact master. */
export function portraitRef(ref: string): string {
  const asset = /^@asset:([0-9a-f-]{36})$/i.exec(ref);
  if (asset) return `/cdn/${asset[1]}?variant=portrait`;
  if (!/^(?:https?:\/\/[^/]+)?\/cdn\/(?:[0-9a-f-]{36}|key\/[\w-]+)(?:\?|$)/i.test(ref)) return ref;
  const url = new URL(ref, 'https://yumina.invalid');
  url.searchParams.set('variant', 'portrait');
  return ref.startsWith('/') ? url.pathname + url.search + url.hash : url.href;
}
