import "server-only";
import { randomUUID } from "node:crypto";
import { APIError, AuthenticationError, TimeoutError } from "@higgsfield/client/v2";
import { getHiggsfieldClient } from "./client";
import { jobStore, type JobResult } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { mirrorToR2 } from "@/lib/storage";
import * as guestDb from "@/lib/guest/db";
import { GUEST_USER_ID } from "@/lib/guestMode";
import { getVideoProviderVariant, type VideoInputMode } from "@/lib/videoProviderCatalog";
import { prepareHiggsfieldMedia } from "./upload";
import { getHiggsfieldCredentials } from "@/lib/guest/db";

export const SEEDANCE_TEXT_TO_VIDEO = "bytedance/seedance-2.0/text-to-video";
const RATIOS = new Set(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]);
const RESOLUTIONS = new Set(["480p", "720p", "1080p", "4k"]);

export interface SeedanceInput {
  prompt: string;
  duration: number;
  resolution: string;
  aspect_ratio: string;
  generate_audio: boolean;
}

export function makeSeedanceInput(body: Record<string, unknown>): SeedanceInput {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const duration = Number(body.duration ?? 5);
  const resolution = body.resolution ?? "720p";
  const aspectRatio = body.aspectRatio ?? body.aspect_ratio ?? "16:9";
  if (!prompt) throw new Error("Seedance 2.0 requires a prompt for Higgsfield.");
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error("Duration must be 4–15 seconds.");
  if (typeof resolution !== "string" || !RESOLUTIONS.has(resolution)) throw new Error("Unsupported Higgsfield resolution.");
  if (typeof aspectRatio !== "string" || !RATIOS.has(aspectRatio)) throw new Error("Unsupported Higgsfield aspect ratio.");
  return { prompt, duration, resolution, aspect_ratio: aspectRatio, generate_audio: Boolean(body.sound ?? body.generate_audio ?? false) };
}

type MediaResource = { url?: string };
function mediaList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item) : [];
}

export function makeHiggsfieldVideoRequest(body: Record<string, unknown>) {
  const modelId = String(body.videoModel ?? body.model ?? "");
  const variant = getVideoProviderVariant(modelId, "higgsfield");
  if (!variant) throw new Error(`Higgsfield does not support model ${modelId}.`);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const duration = Number(body.duration ?? 5);
  if (!Number.isInteger(duration) || duration < variant.minDuration || duration > variant.maxDuration) {
    throw new Error(`Duration must be ${variant.minDuration}–${variant.maxDuration} seconds.`);
  }
  const first = typeof body.startFrameUrl === "string" ? body.startFrameUrl : "";
  const last = typeof body.endFrameUrl === "string" ? body.endFrameUrl : "";
  const images = mediaList(body.referenceImageUrls);
  for (const resource of Array.isArray(body.resources) ? body.resources as MediaResource[] : []) {
    if (typeof resource?.url === "string" && !images.includes(resource.url)) images.push(resource.url);
  }
  const videos = mediaList(body.referenceVideoUrls);
  if (typeof body.videoRefUrl === "string" && body.videoRefUrl) videos.push(body.videoRefUrl);
  const audios = mediaList(body.referenceAudioUrls);
  if (Array.isArray(body.klingElements) && body.klingElements.length) {
    throw new Error("Kling elements are not supported by this Higgsfield variant. Remove them or choose Kie.ai.");
  }
  const hasReferences = images.length > 0 || videos.length > 0 || audios.length > 0;
  if (last && !first) throw new Error("An end frame requires a start frame.");
  if (hasReferences && (first || last)) throw new Error("Frames and references cannot be combined in one Higgsfield request.");
  const mode: VideoInputMode = hasReferences ? "references" : first ? "frames" : "text";
  const endpoint = variant.apiIds?.[mode];
  if (!endpoint) throw new Error(`${modelId} on Higgsfield does not support ${mode} inputs. Choose a compatible model or Kie.ai.`);
  if (!prompt && mode === "text") throw new Error("A prompt is required for text-to-video.");
  const sound = Boolean(body.sound ?? body.generate_audio ?? false);
  const input: Record<string, unknown> = { duration };
  if (prompt) input.prompt = prompt;
  if (modelId === "seedance-2") {
    const resolution = body.resolution ?? "720p";
    const aspectRatio = body.aspectRatio ?? body.aspect_ratio ?? "16:9";
    if (typeof resolution !== "string" || !RESOLUTIONS.has(resolution)) throw new Error("Unsupported Higgsfield resolution.");
    if (typeof aspectRatio !== "string" || !RATIOS.has(aspectRatio)) throw new Error("Unsupported Higgsfield aspect ratio.");
    input.resolution = resolution;
    input.generate_audio = sound;
    if (mode !== "frames") input.aspect_ratio = aspectRatio;
    if (mode === "frames") {
      input.image_url = first;
      if (last) input.end_image_url = last;
    }
    if (mode === "references") {
      if (images.length) input.image_urls = [...new Set(images)];
      if (videos.length) input.video_urls = [...new Set(videos)];
      if (audios.length) input.audio_urls = [...new Set(audios)];
    }
  } else if (modelId === "kling-3.0") {
    const aspectRatio = body.aspectRatio ?? body.aspect_ratio ?? "16:9";
    if (mode === "text" && !["16:9", "9:16", "1:1"].includes(String(aspectRatio))) throw new Error("Kling Higgsfield supports 16:9, 9:16 or 1:1 for text-to-video.");
    input.sound = sound ? "on" : "off";
    if (mode === "text") input.aspect_ratio = aspectRatio;
    if (mode === "frames") {
      input.image_url = first;
      if (last) input.last_image_url = last;
    }
  }
  return { modelId, mode, endpoint, input };
}

function settle(taskId: string, result: JobResult) {
  jobStore.set(taskId, result);
  jobEvents.emit(`job:${taskId}`, result);
  if (result.status === "done") guestDb.updateGeneration(taskId, { status: "done", video_url: result.videoUrl });
  if (result.status === "error") guestDb.updateGeneration(taskId, { status: "error", error_msg: result.error });
}

const activePollers = new Set<string>();

export function resumeHiggsfieldJob(taskId: string): void {
  const pending = jobStore.get(taskId);
  if (pending?.status !== "pending" || !pending.requestId || activePollers.has(taskId)) return;
  const requestId = pending.requestId;
  activePollers.add(taskId);
  void (async () => {
    try {
      const credentials = getHiggsfieldCredentials();
      if (!credentials) throw new Error("Higgsfield credentials are missing. Restore them to resume this job.");
      const base = process.env.HF_API_BASE_URL ?? "https://api.higgsfield.ai";
      const deadline = Date.now() + 11 * 60_000;
      let interval = 3_000;
      while (Date.now() < deadline) {
        let response: Response;
        try {
          response = await fetch(`${base}/requests/${encodeURIComponent(requestId)}/status`, {
            headers: { Authorization: `Key ${credentials.keyId}:${credentials.keySecret}` },
            signal: AbortSignal.timeout(20_000),
          });
        } catch {
          interval = Math.min(interval * 2, 30_000);
          await new Promise(resolve => setTimeout(resolve, interval));
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          interval = Math.min(interval * 2, 30_000);
        } else {
          if (!response.ok) throw new Error(`Higgsfield status check failed (${response.status}).`);
          const result = await response.json() as { status?: string; video?: { url?: string }; detail?: string };
          if (result.status === "completed") {
            if (!result.video?.url) throw new Error("Higgsfield completed without a video URL.");
            let videoUrl = result.video.url;
            try { videoUrl = await mirrorToR2(videoUrl, "videos"); }
            catch { /* Retain the provider URL when local mirroring is unavailable. */ }
            settle(taskId, { status: "done", videoUrl });
            return;
          }
          if (["failed", "nsfw", "canceled"].includes(result.status ?? "")) {
            throw new Error(result.detail || `Higgsfield generation ${result.status}.`);
          }
          if (!["queued", "in_progress", "processing"].includes(result.status ?? "")) {
            throw new Error(`Unexpected Higgsfield status: ${result.status ?? "missing"}.`);
          }
          interval = 3_000;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
      }
      throw new Error("Higgsfield status timed out. Check your account before submitting again.");
    } catch (error) {
      settle(taskId, { status: "error", error: error instanceof Error ? error.message : "Higgsfield status check failed." });
    } finally {
      activePollers.delete(taskId);
    }
  })();
}

export function startHiggsfieldVideo(body: Record<string, unknown>): string {
  const client = getHiggsfieldClient();
  if (!client) throw new Error("Higgsfield is not configured. Add API Key ID and Secret in Settings → API Keys.");
  const { modelId, endpoint, input } = makeHiggsfieldVideoRequest(body);
  const taskId = `higgsfield-${randomUUID()}`;
  jobStore.set(taskId, { status: "pending", type: "video", userId: GUEST_USER_ID });
  guestDb.insertGeneration({
    task_id: taskId, user_id: GUEST_USER_ID, generation_type: "video", status: "pending",
    model: modelId, prompt: String(input.prompt ?? ""), aspect_ratio: String(input.aspect_ratio ?? ""),
    duration: Number(input.duration), sound: Boolean(input.generate_audio ?? input.sound === "on"), reference_image_urls: [],
  });

  void (async () => {
    try {
      const prepared: Record<string, unknown> = { ...input };
      for (const key of ["image_url", "end_image_url", "last_image_url"]) {
        if (typeof prepared[key] === "string") prepared[key] = await prepareHiggsfieldMedia(prepared[key]);
      }
      for (const key of ["image_urls", "video_urls", "audio_urls"]) {
        if (Array.isArray(prepared[key])) prepared[key] = await Promise.all((prepared[key] as string[]).map(prepareHiggsfieldMedia));
      }
      const response = await client.subscribe(endpoint, { input: prepared, withPolling: false });
      if (!response.request_id) throw new Error("Higgsfield did not return a request ID. Check your account before submitting again.");
      jobStore.set(taskId, { status: "pending", type: "video", userId: GUEST_USER_ID, requestId: response.request_id });
      resumeHiggsfieldJob(taskId);
    } catch (error) {
      const message = error instanceof APIError && error.statusCode === 429
        ? "Higgsfield rate limit reached. Try again later."
        : error instanceof TimeoutError
        ? "Higgsfield generation timed out. Check your account before submitting again."
        : error instanceof AuthenticationError
        ? "Higgsfield credentials are invalid. Check Settings → API Keys."
        : error instanceof Error ? error.message : "Higgsfield generation failed.";
      settle(taskId, { status: "error", error: message });
    }
  })();
  return taskId;
}

export const startSeedanceVideo = startHiggsfieldVideo;
