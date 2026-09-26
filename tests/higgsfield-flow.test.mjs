import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mockState = { submits: [], polls: new Map(), kieSubmits: [], kiePolls: 0 };
const mock = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/api/v1/jobs/createTask") {
    assert.equal(req.headers.authorization, "Bearer kie-test-key");
    let body = "";
    for await (const chunk of req) body += chunk;
    mockState.kieSubmits.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 200, data: { taskId: "kie-test-1" } }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/v1/jobs/recordInfo") {
    assert.equal(req.headers.authorization, "Bearer kie-test-key");
    assert.equal(url.searchParams.get("taskId"), "kie-test-1");
    mockState.kiePolls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 200, data: mockState.kiePolls === 1 ? { state: "waiting" } :
      { state: "success", resultJson: JSON.stringify({ resultUrls: [`http://127.0.0.1:${mock.address().port}/video.mp4`] }) } }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/files/generate-upload-url") {
    assert.equal(req.headers.authorization, "Key test-id:test-secret");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ upload_url: `http://127.0.0.1:${mock.address().port}/signed-upload`, upload_headers: { "Content-Type": "image/png" }, public_url: "https://media.example.com/frame.png" }));
    return;
  }
  if (req.method === "PUT" && url.pathname === "/signed-upload") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.ok(Buffer.concat(chunks).length > 0);
    res.writeHead(200); res.end();
    return;
  }
  if (req.method === "POST" && [
    "/bytedance/seedance-2.0/text-to-video", "/bytedance/seedance-2.0/image-to-video",
    "/bytedance/seedance-2.0/reference-to-video", "/kling-video/v3.0/std/text-to-video",
    "/kling-video/v3.0/std/image-to-video",
  ].includes(url.pathname)) {
    assert.equal(req.headers.authorization, "Key test-id:test-secret");
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    mockState.submits.push({ ...input, _endpoint: url.pathname });
    if (input.prompt === "rate limit") {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "Rate limit" }));
      return;
    }
    const requestId = `request-${mockState.submits.length}`;
    mockState.polls.set(requestId, 0);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ request_id: requestId, status: "queued", status_url: `/requests/${requestId}/status` }));
    return;
  }
  const status = url.pathname.match(/^\/requests\/(request-\d+)\/status$/);
  if (req.method === "GET" && status) {
    const count = (mockState.polls.get(status[1]) ?? 0) + 1;
    mockState.polls.set(status[1], count);
    const input = mockState.submits[Number(status[1].split("-")[1]) - 1];
    const state = count === 1 ? "queued" : count < (input.prompt === "resume" ? 5 : 3) ? "in_progress" : input.prompt === "fail" ? "failed" : "completed";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ request_id: status[1], status: state, ...(state === "completed" ? { video: { url: `http://127.0.0.1:${mock.address().port}/video.mp4` } } : {}) }));
    return;
  }
  if (url.pathname === "/video.mp4") {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    res.end(Buffer.from("mock video"));
    return;
  }
  res.writeHead(404);
  res.end();
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(url) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await pause(250);
  }
  throw new Error("HeliosGen did not start");
}

async function waitForJob(base, taskId) {
  for (let i = 0; i < 60; i++) {
    const result = await fetch(`${base}/api/job-status?taskId=${taskId}`).then((r) => r.json());
    if (result.status !== "pending") return result;
    await pause(300);
  }
  throw new Error("Job did not settle");
}

test("Higgsfield credentials, payload, polling, errors and Kie selection", async () => {
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const dataDir = await mkdtemp(join(tmpdir(), "heliosgen-hf-test-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const launch = () => spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(port)], {
    cwd: process.cwd(), env: { ...process.env, HELIOS_DATA_DIR: dataDir, HF_API_BASE_URL: `http://127.0.0.1:${mock.address().port}`, KIE_API_BASE_URL: `http://127.0.0.1:${mock.address().port}`, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
  });
  let child = launch();
  try {
    await waitFor(`${base}/api/settings/higgsfield-key`);
    const status = () => fetch(`${base}/api/settings/higgsfield-key`).then((r) => r.json());
    assert.deepEqual(await status(), { hasToken: false });
    const save = await fetch(`${base}/api/settings/higgsfield-key`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyId: "test-id", keySecret: "test-secret" }),
    });
    assert.equal(save.status, 200);
    assert.deepEqual(await status(), { hasToken: true });

    const generate = (prompt, provider = "higgsfield") => fetch(`${base}/api/generate-video`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoModel: "seedance-2", provider, prompt, duration: 5, resolution: "720p", aspectRatio: "16:9", sound: true }),
    });
    const started = await generate("success");
    assert.equal(started.status, 200);
    const { taskId } = await started.json();
    assert.match(taskId, /^higgsfield-/);
    const done = await waitForJob(base, taskId);
    assert.equal(done.status, "done");
    assert.match(done.videoUrl, /^(\/generated\/videos\/|http:\/\/127\.0\.0\.1:)/);
    assert.deepEqual(mockState.submits[0], { prompt: "success", duration: 5, resolution: "720p", aspect_ratio: "16:9", generate_audio: true, _endpoint: "/bytedance/seedance-2.0/text-to-video" });
    assert.ok(mockState.polls.get("request-1") >= 3);

    const frame = `data:image/png;base64,${Buffer.from("local frame").toString("base64")}`;
    const framed = await fetch(`${base}/api/generate-video`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoModel: "seedance-2", provider: "higgsfield", prompt: "frames", duration: 5,
        resolution: "720p", aspectRatio: "16:9", startFrameUrl: frame, endFrameUrl: frame }),
    });
    assert.equal(framed.status, 200);
    assert.equal((await waitForJob(base, (await framed.json()).taskId)).status, "done");
    assert.equal(mockState.submits[1]._endpoint, "/bytedance/seedance-2.0/image-to-video");
    assert.equal(mockState.submits[1].image_url, "https://media.example.com/frame.png");
    assert.equal(mockState.submits[1].end_image_url, "https://media.example.com/frame.png");
    assert.equal(mockState.submits[1].aspect_ratio, undefined);

    const kling = await fetch(`${base}/api/generate-video`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoModel: "kling-3.0", provider: "higgsfield", prompt: "kling", duration: 5,
        aspectRatio: "9:16", sound: true, startFrameUrl: "https://example.com/first.png", endFrameUrl: "https://example.com/last.png" }),
    });
    assert.equal(kling.status, 200);
    assert.equal((await waitForJob(base, (await kling.json()).taskId)).status, "done");
    assert.equal(mockState.submits[2]._endpoint, "/kling-video/v3.0/std/image-to-video");
    assert.equal(mockState.submits[2].last_image_url, "https://example.com/last.png");

    const references = await fetch(`${base}/api/generate-video`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoModel: "seedance-2", provider: "higgsfield", prompt: "reference", duration: 5,
        resolution: "720p", aspectRatio: "9:16", referenceImageUrls: ["https://example.com/reference.png"] }),
    });
    assert.equal(references.status, 200);
    assert.equal((await waitForJob(base, (await references.json()).taskId)).status, "done");
    assert.equal(mockState.submits[3]._endpoint, "/bytedance/seedance-2.0/reference-to-video");
    assert.deepEqual(mockState.submits[3].image_urls, ["https://example.com/reference.png"]);

    const incompatible = await fetch(`${base}/api/generate-video`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoModel: "kling-3.0", provider: "higgsfield", prompt: "invalid", duration: 5,
        referenceImageUrls: ["https://example.com/reference.png"] }),
    });
    assert.equal(incompatible.status, 400);

    const resumable = await generate("resume");
    assert.equal(resumable.status, 200);
    const resumeTaskId = (await resumable.json()).taskId;
    let requestSaved = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await fetch(`${base}/api/job-status?taskId=${resumeTaskId}`).then(r => r.json());
      if (current.requestId) { requestSaved = true; break; }
      await pause(100);
    }
    assert.ok(requestSaved, "Higgsfield request ID should be persisted before polling");
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    await rm(join(dataDir, ".job-store.json"), { force: true }); // Force SQLite recovery on restart.
    child = launch();
    await waitFor(`${base}/api/settings/higgsfield-key`);
    assert.equal((await waitForJob(base, resumeTaskId)).status, "done");

    const failed = await generate("fail");
    assert.equal((await waitForJob(base, (await failed.json()).taskId)).status, "error");
    const rate = await generate("rate limit");
    assert.equal(rate.status, 400);
    assert.match((await rate.json()).error, /rate limit/i);
    assert.equal(mockState.submits.filter((item) => item.prompt === "rate limit").length, 1);

    const kie = await generate("success", "kie");
    assert.equal(kie.status, 401); // No Kie key in this isolated test data directory.
    assert.match((await kie.json()).error, /Kie.ai/);
    const saveKie = await fetch(`${base}/api/settings/kie-key`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kieApiToken: "kie-test-key" }),
    });
    assert.equal(saveKie.status, 200);
    const kieStarted = await generate("kie positive", "kie");
    assert.equal(kieStarted.status, 200);
    assert.equal((await waitForJob(base, (await kieStarted.json()).taskId)).status, "done");
    assert.equal(mockState.kieSubmits[0].model, "bytedance/seedance-2");
    assert.equal(mockState.kieSubmits[0].input.prompt, "kie positive");
    assert.ok(mockState.kiePolls >= 2);

    await fetch(`${base}/api/settings/higgsfield-key`, { method: "DELETE" });
    assert.deepEqual(await status(), { hasToken: false });
    assert.equal((await generate("success")).status, 400);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => mock.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
