import { useState } from "react";
import { normalizeCoverCrop, type CoverCropSettings } from "./cropping";

export const DEFAULT_WORLD_BANNER_CROP: CoverCropSettings = { x: 0, y: 0, zoom: 1, fit: "contain" };

export function normalizeWorldBannerCrop(value: unknown): CoverCropSettings {
  return normalizeCoverCrop(value && typeof value === "object"
    ? { ...DEFAULT_WORLD_BANNER_CROP, ...value }
    : DEFAULT_WORLD_BANNER_CROP);
}

interface DetailMediaItem {
  id: string;
  thumbnailUrl?: string | null;
  bannerImageUrl?: string | null;
  bannerCrop?: CoverCropSettings | null;
  galleryCoverCrop?: CoverCropSettings | null;
  schema?: Record<string, unknown>;
}

type DetailLayout = "desktop" | "mobile";

function bannerSource(item: DetailMediaItem): string | null {
  const value = item.bannerImageUrl === undefined ? item.schema?.bannerImageUrl : item.bannerImageUrl;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The page banner never changes the portrait used by cards and custom showcases. */
export function resolveWorldDetailMedia(item: DetailMediaItem, layout: DetailLayout, failedSources: readonly string[] = []) {
  const banner = bannerSource(item);
  if (banner && !failedSources.includes(banner)) {
    const crop = item.bannerCrop === undefined ? item.schema?.bannerCrop : item.bannerCrop;
    return { src: banner, hasBanner: true, crop: normalizeWorldBannerCrop(crop) };
  }
  const portrait = item.thumbnailUrl;
  return {
    src: portrait && !failedSources.includes(portrait) ? portrait : null,
    hasBanner: false,
    crop: layout === "desktop" ? { ...normalizeCoverCrop(item.galleryCoverCrop), fit: "cover" as const } : undefined,
  };
}

export function useWorldDetailMedia(item: DetailMediaItem, layout: DetailLayout) {
  const key = JSON.stringify([item.id, bannerSource(item), item.thumbnailUrl]);
  const [failed, setFailed] = useState<{ key: string; sources: string[] }>({ key, sources: [] });
  // Reset during the source-changing render, so no stale failure hides the new
  // story or source. Error callbacks from the previous render cannot poison it.
  if (failed.key !== key) setFailed({ key, sources: [] });
  const media = resolveWorldDetailMedia(item, layout, failed.key === key ? failed.sources : []);
  return {
    ...media,
    onError: () => {
      const source = media.src;
      if (!source) return;
      setFailed(current => current.key === key && !current.sources.includes(source)
        ? { key, sources: [...current.sources, source] }
        : current);
    },
  };
}
