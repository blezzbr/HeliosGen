import { VIDEO_MODELS } from "./modelConfig";

export type VideoProvider = "kie" | "higgsfield";
export type VideoInputMode = "text" | "frames" | "references";

export interface VideoProviderVariant {
  modelId: string;
  provider: VideoProvider;
  modes: readonly VideoInputMode[];
  resolutions: readonly string[];
  minDuration: number;
  maxDuration: number;
  apiIds?: Partial<Record<VideoInputMode, string>>;
}

const higgsfieldVariants: readonly VideoProviderVariant[] = [
  {
    modelId: "seedance-2", provider: "higgsfield", modes: ["text", "frames", "references"],
    resolutions: ["480p", "720p", "1080p", "4k"], minDuration: 4, maxDuration: 15,
    apiIds: {
      text: "bytedance/seedance-2.0/text-to-video",
      frames: "bytedance/seedance-2.0/image-to-video",
      references: "bytedance/seedance-2.0/reference-to-video",
    },
  },
  {
    modelId: "kling-3.0", provider: "higgsfield", modes: ["text", "frames"],
    resolutions: [], minDuration: 3, maxDuration: 15,
    apiIds: {
      text: "kling-video/v3.0/std/text-to-video",
      frames: "kling-video/v3.0/std/image-to-video",
    },
  },
];

export function getVideoProviderVariant(modelId: string, provider: VideoProvider): VideoProviderVariant | undefined {
  if (provider === "higgsfield") return higgsfieldVariants.find((variant) => variant.modelId === modelId);
  const model = VIDEO_MODELS.find((item) => item.id === modelId);
  if (!model) return undefined;
  const modes: VideoInputMode[] = ["text"];
  if (model.handles.includes("startFrame")) modes.push("frames");
  if (model.handles.some((handle) => handle === "resource" || handle === "referenceVideo" || handle === "audioRef")) modes.push("references");
  return { modelId, provider, modes, resolutions: model.resolutions ?? [], minDuration: model.apiInput.durationMin, maxDuration: model.apiInput.durationMax };
}

export function getVideoProviders(modelId: string): VideoProvider[] {
  return (["kie", "higgsfield"] as const).filter((provider) => !!getVideoProviderVariant(modelId, provider));
}

export interface VideoCostEstimate {
  amountUsd: number | null;
  source: string | null;
  note: string;
}

/** Published undiscounted Seedance 2.0 token formula; actual billing may differ. */
export function estimateVideoCost(input: {
  modelId: string; provider: VideoProvider; duration: number; resolution: string; aspectRatio: string;
  inputVideoSeconds?: number;
}): VideoCostEstimate {
  if (input.provider !== "higgsfield" || input.modelId !== "seedance-2") {
    return { amountUsd: null, source: null, note: "Price unavailable for this provider and model." };
  }
  const height = ({ "480p": 480, "720p": 720, "1080p": 1080, "4k": 2160 } as Record<string, number>)[input.resolution];
  const ratios: Record<string, number> = { "16:9": 16 / 9, "4:3": 4 / 3, "1:1": 1, "3:4": 3 / 4, "9:16": 9 / 16, "21:9": 21 / 9 };
  const ratio = ratios[input.aspectRatio];
  if (!height || !ratio || !Number.isFinite(input.duration) || input.duration <= 0) {
    return { amountUsd: null, source: null, note: "Select a supported duration, resolution and aspect ratio." };
  }
  // Resolution is the longer dimension in the documented price examples.
  const longSide = height * Math.max(ratio, 1);
  const shortSide = height / Math.max(1, ratio);
  const inputSeconds = Math.max(0, input.inputVideoSeconds ?? 0);
  const tokens = Math.ceil((input.duration + inputSeconds) * longSide * shortSide * 24 / 1024);
  const rate = inputSeconds > 0 ? (height === 2160 ? 0.0048 : 0.0084) : (height === 2160 ? 0.008 : 0.014);
  return {
    amountUsd: Math.ceil(tokens / 1000 * rate * 10000) / 10000,
    source: "https://open.higgsfield.ai/models/bytedance/seedance-2.0/text-to-video/playground",
    note: "Estimated USD before discounts; final provider charge may differ.",
  };
}
