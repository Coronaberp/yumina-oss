import { useEffect, useMemo, useRef, useState } from "react";
import { readCardShowcase, type CardShowcase as CardShowcaseData } from "@yumina/engine";
import { buildCardShowcaseDocument } from "@/lib/card-showcase-document";
import { cn } from "@/lib/utils";

type CardProfileProps = { name: string; description: string; cover?: string | null; className?: string };
const apiBase = import.meta.env.VITE_API_URL || "";

export function CardShowcase({ showcase, name, description, cover, className, title = "Card showcase" }: CardProfileProps & {
  showcase: CardShowcaseData; title?: string;
}) {
  const [height, setHeight] = useState(480);
  const frame = useRef<HTMLIFrameElement>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const document = useMemo(() => buildCardShowcaseDocument(showcase, { name, description, cover }), [showcase, name, description, cover]);
  useEffect(() => () => observer.current?.disconnect(), []);
  const measure = () => {
    observer.current?.disconnect();
    const root = frame.current?.contentDocument?.querySelector("main.card-showcase");
    if (!root) return;
    const resize = () => setHeight(Math.min(20_000, Math.max(64, Math.ceil(root.getBoundingClientRect().height))));
    observer.current = new ResizeObserver(resize);
    observer.current.observe(root);
    resize();
  };
  // Same-origin media works with installation cookies; scripts remain forbidden.
  return <iframe ref={frame} title={title} srcDoc={document} onLoad={measure} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    referrerPolicy="no-referrer" className={cn("block w-full min-w-0 border-0", className)} style={{ height }} />;
}

/** Library rows are schema-free; fetch only public display metadata when needed. */
export function PublishedCardShowcase({ worldId, showcase, ...profile }: CardProfileProps & { worldId: string; showcase?: unknown }) {
  const [loaded, setLoaded] = useState<{ worldId: string; value: unknown } | null>(null);
  useEffect(() => {
    if (showcase !== undefined) return;
    const controller = new AbortController();
    void fetch(`${apiBase}/api/worlds/${encodeURIComponent(worldId)}?preview=true`, { credentials: "include", signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const body = await response.json() as { data?: { cardShowcase?: unknown } };
        if (!controller.signal.aborted) setLoaded({ worldId, value: body.data?.cardShowcase });
      }).catch(() => { /* A missing/inaccessible profile keeps its standard description. */ });
    return () => controller.abort();
  }, [worldId, showcase]);
  const value = showcase ?? (loaded?.worldId === worldId ? loaded.value : undefined);
  let parsed: CardShowcaseData;
  try { parsed = readCardShowcase(value); } catch { return null; }
  if (!parsed.html.trim() && !parsed.css.trim()) return null;
  return <CardShowcase showcase={parsed} {...profile} />;
}
