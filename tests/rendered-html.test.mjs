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

test("server renders the DGSI application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>DGSI — Dynamic Gaussian Scene Intelligence<\/title>/i);
  assert.match(html, /SCENE INTELLIGENCE/);
  assert.match(html, /SEMANTIC LAYERS/);
  assert.match(html, /CHANGE INTELLIGENCE/);
  assert.match(html, /Import images \+ videos/);
  assert.match(html, /aria-label="Interactive reconstructed scene"/);
  assert.match(html, /aria-label="Rendering budget"/);
  assert.match(html, /Hide selected class|Whole scene/);
  assert.match(html, /Walk through space/);
  assert.match(html, /Switch color theme/);
  assert.match(html, /INPUT VIEWS/);
  assert.match(html, /Living-room source view 00/);
  assert.match(html, /Toggle completed environment/);
  assert.match(html, /Toggle rendered room and splat inspection/);
  assert.match(html, /RENDERED ROOM/);
  assert.match(html, /Preparing 360° context/);
  assert.match(html, /prefers-color-scheme: light/);
  assert.doesNotMatch(html, /starter-preview|Your site is taking shape|react-loading-skeleton/i);
});
