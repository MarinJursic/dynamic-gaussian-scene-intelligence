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

test("server renders the Spatial Capture Room application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Spatial Capture Room — Photographic Context &amp; 3DGS<\/title>/i);
  assert.match(html, /Spatial/);
  assert.match(html, /Capture Room/);
  assert.match(html, /Capture/);
  assert.match(html, /Register/);
  assert.match(html, /Optimize/);
  assert.match(html, /Publish/);
  assert.match(html, /Add capture \/ splat/);
  assert.match(html, /AWS kitchen SOG/);
  assert.match(html, /AWS Venetian Hall SOG/);
  assert.match(html, /aria-label="Interactive reconstructed scene"/);
  assert.match(html, /360° photographic capture/);
  assert.match(html, /not trained 3DGS/);
  assert.match(html, /Source match/);
  assert.match(html, /Coverage/);
  assert.match(html, /Inspect/);
  assert.match(html, /Walk/);
  assert.match(html, /Tour/);
  assert.match(html, /360°/);
  assert.match(html, /Reset/);
  assert.match(html, /Observed source/);
  assert.match(html, /ESO source/);
  assert.match(html, /Scene details/);
  assert.match(html, /prefers-color-scheme: light/);
  assert.doesNotMatch(html, /starter-preview|Your site is taking shape|react-loading-skeleton/i);
});
