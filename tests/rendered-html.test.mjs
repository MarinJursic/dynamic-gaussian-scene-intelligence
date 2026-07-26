import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server renders the Spatial Forge application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Spatial Forge — Image-to-World Studio<\/title>/i);
  assert.match(html, /Spatial/);
  assert.match(html, /Spatial Forge/);
  assert.match(html, /Built-in spatial example/);
  assert.match(html, /Create world/);
  assert.match(html, /AWS kitchen SOG/);
  assert.match(html, /Layered capture demo/);
  assert.match(html, /aria-label="Interactive spatial scene"/);
  assert.match(html, /aria-describedby="camera-instructions"/);
  assert.match(html, /aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight W A S D"/);
  assert.match(html, /Drag to look around/);
  assert.match(html, /role="group" aria-label="Camera controls"/);
  assert.match(html, /aria-controls="scene-inspector"/);
  assert.match(html, /360° photographic capture/);
  assert.match(html, /not trained 3DGS/);
  assert.match(html, /Source match/);
  assert.match(html, /Coverage/);
  assert.match(html, /Point proxy/);
  assert.match(html, /Walk/);
  assert.match(html, /Auto look/);
  assert.match(html, /Reset/);
  assert.match(html, /Observed source/);
  assert.match(html, /ESO source/);
  assert.match(html, /Scene details/);
  assert.match(html, /Procedural world route/);
  assert.match(html, /Approach doorway/);
  assert.match(html, /Loading photographic context/);
  assert.match(html, /prefers-color-scheme: light/);
  assert.doesNotMatch(html, /starter-preview|Your site is taking shape|react-loading-skeleton/i);
});
