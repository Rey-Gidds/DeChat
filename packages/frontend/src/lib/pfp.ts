// Profile picture metadata stored in Cloudflare R2 object storage.
export interface PfpMetadata {
  type: "avatar";
  objectKey: string;
  mimeType: string;
  size: number;
  updatedAt: string;
}

const CDN_BASE = (process.env.NEXT_PUBLIC_R2_PUBLIC_URL ?? "").replace(/\/$/, "");

/** Resolves a PfpMetadata (or legacy base64/URL string) to a full CDN URL. */
export function pfpUrl(pfp: PfpMetadata | string | null | undefined): string | null {
  if (!pfp) return null;
  if (typeof pfp === "string") {
    return pfp.startsWith("data:") || pfp.startsWith("http") ? pfp : null;
  }
  return CDN_BASE ? `${CDN_BASE}/${pfp.objectKey}` : null;
}
