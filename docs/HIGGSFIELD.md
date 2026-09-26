# Video providers

## Architecture

`lib/modelConfig.ts` remains the existing model catalog and Kie request mapping. `lib/videoProviderCatalog.ts` defines the supported provider variant, input mode, duration, resolution and cost estimator. Kie remains the default for every model. `lib/providers.ts` stores per-model defaults in browser localStorage; each Video Generator node can override the provider in its own workflow data, so one workflow can use both providers. Gallery uses the per-model default. `/api/generate-video` dispatches to the Higgsfield adapter for selected variants and otherwise keeps the existing Kie route. Both providers return a `taskId` consumed by `/api/job-status` and `/api/job-stream`.

Higgsfield credentials stay in the local SQLite settings database or server environment. `lib/providers/higgsfield/upload.ts` converts local `/generated/` or `data:` media into provider-reachable signed uploads. The V2 SDK submits once with retries disabled, stores the provider `request_id` alongside the local task, and the server polls the official status URL. An open node or gallery resumes polling after a local server restart without submitting again. Completed media is mirrored to local storage when possible.

## Supported variants

| Model | Provider | Inputs | Provider model ID |
| --- | --- | --- | --- |
| Existing video catalog | Kie.ai | Existing per-model capabilities | Existing `lib/modelConfig.ts` mapping |
| Seedance 2.0 | Higgsfield | Text | `bytedance/seedance-2.0/text-to-video` |
| Seedance 2.0 | Higgsfield | Start frame, optional end frame | `bytedance/seedance-2.0/image-to-video` |
| Seedance 2.0 | Higgsfield | Image, video and audio references | `bytedance/seedance-2.0/reference-to-video` |
| Kling 3.0 Standard | Higgsfield | Text | `kling-video/v3.0/std/text-to-video` |
| Kling 3.0 Standard | Higgsfield | Start frame, optional end frame | `kling-video/v3.0/std/image-to-video` |

Frames and multimodal references are mutually exclusive for Seedance on Higgsfield. Higgsfield Kling elements are not mapped; the UI blocks them and the server rejects them. Image-to-video endpoints follow the input frame's aspect ratio; their schemas do not accept the ratio control. Kie retains its original mode and input mappings.

## Cost estimate

For Higgsfield Seedance 2.0, the UI calculates USD from the [published video-token formula](https://open.higgsfield.ai/models/bytedance/seedance-2.0/text-to-video/playground), selected duration, resolution and aspect ratio. It is an estimate before discounts; final billing can differ. With frame input, `*` notes that the estimate assumes the selected ratio, while the actual output can follow the frame. Video references add billable input duration and show unavailable until media metadata is available. Kie and Higgsfield Kling currently show unavailable.

## Configure and run

1. Install with `corepack pnpm install` and run `corepack pnpm dev`.
2. In Settings → API Keys, save Higgsfield API Key ID and API Key Secret. Server environment `HF_API_KEY_ID` and `HF_API_KEY_SECRET` are also supported. Kie has its own existing key.
3. In Gallery → Video, select Seedance 2.0 or Kling 3.0 and then Kie.ai or Higgsfield. In Workflow, each Video Generator node has its own provider choice. Switching takes effect immediately.
4. Connect a prompt, start/end frames or references supported by the selected variant. The Generate button is disabled when the chosen provider lacks credentials.

The saved key follows HeliosGen's existing local SQLite storage and is never returned to the browser. Like the existing Kie key, SQLite storage is not encrypted with the macOS Keychain. Do not commit credentials.

Run `corepack pnpm test:higgsfield` for a local API simulator covering credentials, provider routing, signed upload, payloads, polling, errors and restart recovery. Run `corepack pnpm exec tsc --noEmit`, `corepack pnpm lint` and `corepack pnpm build` for project checks. Live paid generation requires the user's provider keys and credits and was not exercised in this PR.

## Next PR

1. Add Wan and additional Kling variants after verifying each official input schema and price contract.
2. Add Soul / Soul ID and Cinema Studio as separate image/video adapter variants.
3. Capture video-reference duration so Seedance reference cost can include input tokens; show Kie costs from an authoritative pricing source or account estimate endpoint when available.
4. Add manual fallback Kie → Higgsfield after checking the first job's terminal status and asking the user before a second billable submission.
5. Add durable job reconciliation on app startup and cancellation UI for providers that expose an official cancel endpoint.
