import type { ImageMasterMetadata } from "./image-master-envelope.js";
export type VerifiedCopyMetadata = { MetadataDirective: "REPLACE"; ContentType: string; ContentEncoding?: string; Metadata?: Record<string, string> };

export interface CopiedObjectMetadata extends ImageMasterMetadata {
  etag: string | null;
  contentLength: number;
  contentType: string;
}

/** S3-compatible providers may ignore CopySourceIfMatch. Inspect the immutable
 * destination before its database registration can make it public. */
export async function copyAndVerifyObject(
  copy: (metadata?: VerifiedCopyMetadata) => Promise<unknown>,
  head: () => Promise<CopiedObjectMetadata>,
  expected: { etag: string; contentLength?: number } & Partial<ImageMasterMetadata>,
): Promise<void> {
  // The destination is addressable by the raw public CDN key before its DB
  // registration. Pin its safe MIME during copy, not after exposure.
  const metadata = {
    ...(expected.decodedLength !== undefined ? { "decoded-size": String(expected.decodedLength) } : {}),
    ...(expected.sourceSha256 !== undefined ? { "source-sha256": expected.sourceSha256 } : {}),
    ...(expected.storedSha256 !== undefined ? { "stored-sha256": expected.storedSha256 } : {}),
  };
  await copy(expected.contentType === undefined ? undefined : {
    MetadataDirective: "REPLACE", ContentType: expected.contentType,
    ...(expected.contentEncoding !== undefined ? { ContentEncoding: expected.contentEncoding } : {}),
    ...(Object.keys(metadata).length ? { Metadata: metadata } : {}),
  });
  const actual = await head();
  const normalizeEtag = (value: string) => value.replace(/^"|"$/g, "");
  if (!actual.etag || normalizeEtag(actual.etag) !== normalizeEtag(expected.etag)
    || (expected.contentLength !== undefined && actual.contentLength !== expected.contentLength)
    || (expected.contentType !== undefined && actual.contentType !== expected.contentType)
    || ["contentEncoding", "decodedLength", "sourceSha256", "storedSha256"].some(key => {
      const field = key as keyof ImageMasterMetadata;
      return expected[field] !== undefined && actual[field] !== expected[field];
    })) {
    // Keep the unregistered candidate for the normal sweeper; never publish it.
    throw new Error("Uploaded object changed during registration");
  }
}
