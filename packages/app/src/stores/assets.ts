import { create } from "zustand";
import {
  uploadAssetWithPresignedUrl,
  type UploadProgress,
} from "@/lib/asset-upload";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";

export interface Asset {
  id: string;
  worldId: string;
  type: "image" | "video" | "audio" | "font" | "txt" | "other";
  filename: string;
  url: string; // presigned GET URL
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

export interface WorldAssetUploadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  silent?: boolean;
}

interface AssetState {
  assets: Asset[];
  loading: boolean;
  uploading: boolean;
  uploadingCount: number;
  uploadProgress: UploadProgress | null;
  storage: { used: number; limit: number | null };

  fetchAssets: (worldId: string) => Promise<void>;
  uploadAsset: (
    worldId: string,
    file: File,
    type: "image" | "video" | "audio" | "font" | "txt" | "other",
    options?: WorldAssetUploadOptions
  ) => Promise<Asset | null>;
  deleteAsset: (worldId: string, assetId: string) => Promise<void>;
  clear: () => void;
}

const apiBase = import.meta.env.VITE_API_URL || "";

const tr = (key: string, fallback: string) =>
  (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, { defaultValue: fallback });

export const useAssetStore = create<AssetState>((set) => {
  let activeWorldId: string | null = null;
  let scopeVersion = 0;
  function selectWorld(worldId: string) {
    if (activeWorldId !== worldId) {
      activeWorldId = worldId;
      scopeVersion++;
      set({ assets: [], loading: false, uploading: false, uploadingCount: 0, uploadProgress: null });
    }
    return scopeVersion;
  }
  return {
  assets: [],
  loading: false,
  uploading: false,
  uploadingCount: 0,
  uploadProgress: null,
  storage: { used: 0, limit: null },

  fetchAssets: async (worldId) => {
    const scope = selectWorld(worldId);
    set({ loading: true });
    try {
      const res = await fetch(`${apiBase}/api/worlds/${worldId}/assets`, {
        credentials: "include",
      });
      if (!res.ok) {
        if (scope === scopeVersion) set({ loading: false });
        return;
      }
      const { data } = await res.json();
      if (scope === scopeVersion) set({ assets: data ?? [], loading: false });
    } catch {
      if (scope === scopeVersion) set({ loading: false });
    }
  },

  uploadAsset: async (worldId, file, type, options = {}) => {
    if (options.signal?.aborted) return null;
    const scope = selectWorld(worldId);
    const current = () => scope === scopeVersion && !options.signal?.aborted;
    set((s) => ({
      uploadingCount: s.uploadingCount + 1,
      uploading: true,
      uploadProgress: null,
    }));

    try {
      const asset = await uploadAssetWithPresignedUrl<Asset>({
        file,
        preferredType: type,
        signal: options.signal,
        prepareUrl: `${apiBase}/api/worlds/${worldId}/assets/upload-url`,
        registerUrl: `${apiBase}/api/worlds/${worldId}/assets`,
        registerBody: ({ key, resolvedType, contentType }) => ({
          key,
          filename: file.name,
          type: resolvedType,
          mimeType: contentType,
          sizeBytes: file.size,
        }),
        onProgress: (progress) => {
          if (!current()) return;
          set({ uploadProgress: progress });
          options.onProgress?.(progress);
        },
      });

      if (!current()) return null;
      set((s) => ({
        assets: [...s.assets, asset],
        storage: { ...s.storage, used: s.storage.used + (asset.sizeBytes ?? file.size ?? 0) },
      }));

      // R6/T0: the grid shows a progress bar while this runs and the new asset
      // lands in it — the upload announces itself.
      return asset;
    } catch (error) {
      if (current() && !options.silent && !(error instanceof Error && error.name === "AbortError")) {
        feedback.error(tr("library:assets.uploadFailed", "Couldn't upload the file"));
      }
      return null;
    } finally {
      if (scope === scopeVersion) set((s) => {
        const uploadingCount = Math.max(0, s.uploadingCount - 1);

        return {
          uploadingCount,
          uploading: uploadingCount > 0,
        };
      });
    }
  },

  // R5/T4: the delete already runs behind a confirm dialog and the tile leaves
  // the grid, so only the failure — which leaves the tile there — speaks.
  deleteAsset: async (worldId, assetId) => {
    const failed = () =>
      feedback.error(tr("library:assets.deleteFailed", "Couldn't delete the asset"));
    try {
      const res = await fetch(`${apiBase}/api/worlds/${worldId}/assets/${assetId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        failed();
        return;
      }
      set((s) => {
        const deleted = s.assets.find((a) => a.id === assetId);
        return {
          assets: s.assets.filter((a) => a.id !== assetId),
          storage: {
            ...s.storage,
            used: Math.max(0, s.storage.used - (deleted?.sizeBytes ?? 0)),
          },
        };
      });
    } catch {
      failed();
    }
  },

  clear: () => {
    scopeVersion++;
    activeWorldId = null;
    set({
      assets: [],
      loading: false,
      uploading: false,
      uploadingCount: 0,
      uploadProgress: null,
      storage: { used: 0, limit: null },
    });
  },
  };
});
