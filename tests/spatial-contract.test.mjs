import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeDgsi, validateManifest } from "../app/scene-format.ts";

const root = new URL("../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("JPEG dimensions were not found");
}

test("hosted scene is a high-resolution real-photo context with explicit provenance", async () => {
  const context = await readFile(new URL("public/captures/eso-guesthouse/context.jpg", root));
  const dimensions = jpegDimensions(context);
  assert.ok(dimensions.width >= 6000);
  assert.ok(dimensions.height >= 3000);

  const webglContext = await readFile(new URL("public/captures/eso-guesthouse/context-webgl.jpg", root));
  assert.deepEqual(jpegDimensions(webglContext), { width: 4096, height: 2048 });

  const manifest = JSON.parse(await text("public/room-demo/manifest.json"));
  assert.equal(manifest.environment.generated, false);
  assert.equal(manifest.source.image_count, 12);
  assert.equal(manifest.quality.reconstruction_mode, "panorama-context-with-cpu-proxy");
  assert.equal(manifest.provenance.source_license, "CC BY 4.0");
  assert.equal(manifest.provenance.production_gaussian_optimized, false);
});

test("hosted manifest and proxy binary decode together", async () => {
  const manifest = validateManifest(JSON.parse(await text("public/room-demo/manifest.json")));
  const bytes = await readFile(new URL("public/room-demo/scene.dgsi", root));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const decoded = decodeDgsi(buffer, manifest);

  assert.equal(decoded.count, manifest.point_count);
  assert.equal(decoded.positions.length, manifest.point_count * 3);
});

test("bundled AWS interior examples are intact trained SOG archives", async () => {
  const expected = new Map([
    ["kitchen-island.sog", "4c3c90933f5c52122b033e2b82ca7b258eeb2ea314eb0f59caffb83d0b44a8cd"],
    ["venetian-hall-panos.sog", "e413ff3fe21937e901842de3bf0db767cfafa6a1ae7bd7e3e2a885f3e2090bcd"],
  ]);
  for (const [name, digest] of expected) {
    const bytes = await readFile(new URL(`public/splats/${name}`, root));
    assert.ok(bytes.byteLength > 4_000_000);
    assert.equal(bytes.subarray(0, 2).toString("ascii"), "PK");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
  }
});

test("viewer contract distinguishes photographic context, proxy points, and true SPZ data", async () => {
  const source = await text("app/scene-studio.tsx");
  assert.match(source, /new SparkRenderer/);
  assert.match(source, /new SplatMesh/);
  assert.match(source, /lod: "quality"/);
  assert.match(source, /Imported anisotropic Gaussian/);
  assert.match(source, /CPU preview proxy/);
  assert.match(source, /not trained 3DGS/);
  assert.match(source, /getPointAt/);
  assert.match(source, /quaternion\.slerp/);
  assert.match(source, /walkPosition\.clamp/);
  assert.match(source, /Smooth 360° look-around/);
  assert.match(source, /context-webgl\.jpg/);
  assert.match(source, /runtime\.environment\.visible = true/);
  assert.match(source, /result\.scene_url/);
  assert.match(source, /await loadProxyScene\(result\.scene_url\)/);
  assert.match(source, /nextSplat\.getBoundingBox\(\)/);
  assert.match(source, /setSceneOrigin\("spz"\)/);
  assert.match(source, /material\.color\.setScalar\(exposure \/ 100\)/);
  assert.match(source, /degToRad\(index \* 30\)/);
});
