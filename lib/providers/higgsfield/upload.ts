import "server-only";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { MEDIA_DIR } from "@/lib/guest/paths";
import { getHiggsfieldCredentials } from "@/lib/guest/db";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

export async function prepareHiggsfieldMedia(url: string): Promise<string> {
  if (/^https:\/\//i.test(url)) return url;
  let bytes: Buffer;
  let contentType: string;
  if (url.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|webp)|video\/(?:mp4|webm)|audio\/(?:mpeg|wav|mp4));base64,([\s\S]+)$/.exec(url);
    if (!match) throw new Error("Unsupported Higgsfield media data URL.");
    contentType = match[1];
    bytes = Buffer.from(match[2], "base64");
  } else if (url.startsWith("/generated/")) {
    const mediaPath = resolve(MEDIA_DIR, url.slice("/generated/".length));
    if (!mediaPath.startsWith(resolve(MEDIA_DIR) + sep)) throw new Error("Invalid local media path.");
    contentType = CONTENT_TYPES[extname(mediaPath).toLowerCase()];
    if (!contentType) throw new Error("Unsupported Higgsfield media type.");
    bytes = await readFile(mediaPath);
  } else {
    throw new Error("Higgsfield references must be HTTPS URLs or local generated media.");
  }
  if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw new Error("Higgsfield media must be between 1 byte and 100 MB.");
  const credentials = getHiggsfieldCredentials();
  if (!credentials) throw new Error("Higgsfield is not configured.");
  const base = process.env.HF_API_BASE_URL ?? "https://api.higgsfield.ai";
  const signed = await fetch(`${base}/files/generate-upload-url`, {
    method: "POST", headers: { Authorization: `Key ${credentials.keyId}:${credentials.keySecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content_type: contentType }),
  });
  if (!signed.ok) throw new Error(`Higgsfield upload preparation failed (${signed.status}).`);
  const result = await signed.json() as { upload_url?: string; upload_headers?: Record<string, string>; public_url?: string };
  if (!result.upload_url || !result.public_url || !/^https?:\/\//.test(result.upload_url)) throw new Error("Invalid Higgsfield upload response.");
  const uploaded = await fetch(result.upload_url, { method: "PUT", headers: result.upload_headers, body: new Uint8Array(bytes) });
  if (!uploaded.ok) throw new Error(`Higgsfield media upload failed (${uploaded.status}).`);
  return result.public_url;
}
