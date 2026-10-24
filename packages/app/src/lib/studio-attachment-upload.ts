import type { ChatAttachment } from "@/features/studio/lib/types";
import { uploadAssetWithPresignedUrl, type UploadProgress } from "./asset-upload";

/** Studio attachments become usable only after the server verifies their master. */
export async function uploadStudioAttachments(files: File[], options: {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
} = {}): Promise<ChatAttachment[]> {
  const base = options.apiBase ?? import.meta.env?.VITE_API_URL ?? "";
  const attachments: ChatAttachment[] = [];
  for (const file of files) {
    options.signal?.throwIfAborted();
    const attachment = await uploadAssetWithPresignedUrl<ChatAttachment>({
      file, preferredType: "image", fetchImpl: options.fetchImpl,
      signal: options.signal, onProgress: options.onProgress,
      prepareUrl: `${base}/api/studio/upload-url`,
      prepareBody: { fileSize: file.size },
      registerUrl: `${base}/api/studio/upload-confirm`,
      registerBody: ({ key, contentType }) => ({ key, filename: file.name, contentType, fileSize: file.size }),
    });
    options.signal?.throwIfAborted();
    attachments.push(attachment);
  }
  return attachments;
}
