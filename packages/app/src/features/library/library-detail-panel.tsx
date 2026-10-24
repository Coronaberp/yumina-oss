import { useEffect, useLayoutEffect, useState } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  LibraryDetailPanelDesktop,
  type LibraryDetailPanelProps,
} from "./library-detail-panel-desktop";
import { LibraryDetailPanelMobile } from "./library-detail-panel-mobile";

export type { LibraryDetailPanelProps } from "./library-detail-panel-desktop";

const apiBase = import.meta.env.VITE_API_URL || "";

export function LibraryDetailPanel(incomingProps: LibraryDetailPanelProps) {
  const item = incomingProps.selectedItem;
  const [preview, setPreview] = useState<{
    item: typeof item;
    bannerImageUrl: string | null;
    bannerCrop: typeof item.bannerCrop;
  } | null>(null);
  // Library rows intentionally carry no private schema. Fetch only the existing
  // display preview so a synthetic row can use the same banner as owned cards.
  useEffect(() => {
    if (item.bannerImageUrl !== undefined || Object.keys(item.schema ?? {}).length > 0) return;
    const controller = new AbortController();
    void fetch(`${apiBase}/api/worlds/${encodeURIComponent(item.id)}?preview=true`, {
      credentials: "include", signal: controller.signal,
    }).then(async response => {
      if (!response.ok) return;
      const body = await response.json();
      if (controller.signal.aborted || body?.data?.id !== item.id) return;
      setPreview({
        item,
        bannerImageUrl: typeof body.data.bannerImageUrl === "string" ? body.data.bannerImageUrl : null,
        bannerCrop: body.data.bannerCrop ?? null,
      });
    }).catch(() => { /* Existing portrait remains available if preview cannot load. */ });
    return () => controller.abort();
  }, [item]);
  const props = preview?.item === item
    ? { ...incomingProps, selectedItem: { ...item, bannerImageUrl: preview.bannerImageUrl, bannerCrop: preview.bannerCrop } }
    : incomingProps;
  const isMobileDetail = useMediaQuery("(max-width: 767px)");

  // A different story starts at its cover. Keep this in the stable parent:
  // swapping mobile/desktop markup on rotation must not reset the reading
  // position, and refreshing the same story must not reset it either.
  useLayoutEffect(() => {
    const detail = document.querySelector<HTMLElement>('[data-scroll-restoration-id="library-detail"]');
    detail?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    detail?.closest<HTMLElement>(".app-shell-main-mobile-scrollable")?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [props.selectedItem.id]);

  return isMobileDetail
    ? <LibraryDetailPanelMobile {...props} />
    : <LibraryDetailPanelDesktop {...props} />;
}
