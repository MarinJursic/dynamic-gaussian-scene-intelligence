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

  const highResolutionContext = await readFile(
    new URL("public/captures/eso-guesthouse/context-8k.jpg", root),
  );
  assert.deepEqual(jpegDimensions(highResolutionContext), { width: 8192, height: 4096 });

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

test("bundled AWS kitchen example is an intact trained SOG archive", async () => {
  const expected = new Map([
    ["kitchen-island.sog", "4c3c90933f5c52122b033e2b82ca7b258eeb2ea314eb0f59caffb83d0b44a8cd"],
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
  assert.match(source, /enableLod: false/);
  assert.match(source, /sortRadial: true/);
  assert.match(source, /minSortIntervalMs: 0/);
  assert.match(source, /preBlurAmount: 0/);
  assert.match(source, /blurAmount: 0/);
  assert.match(source, /focalAdjustment: 1\.35/);
  assert.match(source, /Imported anisotropic Gaussian/);
  assert.match(source, /CPU preview proxy/);
  assert.match(source, /Deterministic completed context/);
  assert.match(source, /completedPanoramaFromMedia/);
  assert.match(source, /continuationFromPanorama/);
  assert.match(source, /videoSampleFractions\(duration\)/);
  assert.match(source, /frames\.length < 8/);
  assert.match(source, /renderedCaptureEvidence/);
  assert.match(source, /buildProceduralRoom/);
  assert.match(source, /loadLayeredDemo/);
  assert.match(source, /new THREE\.PlaneGeometry/);
  assert.match(source, /roomLayerUrlsRef/);
  assert.match(source, /RoomProvenance/);
  assert.match(source, /roomAfterPortalAction\(activeRoom, "enter", portalPhase\)/);
  assert.match(source, /roomAfterPortalAction\(activeRoom, "return", portalPhase\)/);
  assert.match(source, /Generate beyond doorway/);
  assert.match(source, /nextPortalPhase/);
  assert.match(source, /NEXT_PUBLIC_WORLD_COMPLETION_API_URL/);
  assert.match(source, /Non-metric bounded context/);
  assert.match(source, /not trained 3DGS/);
  assert.match(source, /MAX_LOOK_PITCH = THREE\.MathUtils\.degToRad\(89\)/);
  assert.match(source, /dampedCameraValue\(runtime\.yaw, runtime\.desiredYaw, 18, delta\)/);
  assert.match(source, /tourBaseYaw \+ lookAroundYaw/);
  assert.match(source, /walkPosition\.clamp/);
  assert.match(source, /Stable full-resolution 360° look-around/);
  assert.match(source, /context-webgl\.jpg/);
  assert.match(source, /context-8k\.jpg/);
  assert.match(source, /runtime\.environment\.visible = runtime\.sceneClass === "panorama-context"/);
  assert.match(source, /nextSplat\.getBoundingBox\(true\)\.applyMatrix4/);
  assert.match(source, /setSceneOrigin\("spz"\)/);
  assert.match(source, /material\.color\.setScalar\(exposure \/ 100\)/);
  assert.match(source, /degToRad\(index \* 30\)/);
  assert.match(source, /bounds\.containsPoint\(registeredOrigin\)/);
  assert.match(source, /runtime\.canTranslate = isBundledKitchen/);
  assert.match(source, /rotate-only until a registered camera hull is supplied/);
  assert.match(source, /runtime\.canTranslate = checked\.spatial\.navigable/);
  assert.match(source, /Interactive spatial scene/);
  assert.match(source, /runtime\.camera\.fov = 68/);
  assert.match(source, /settleCamera\(runtime, delta, runtime\.dragging\)/);
  assert.match(source, /runtime\.reducedMotion/);
  assert.doesNotMatch(source, /function settleCamera[\s\S]{0,240}window\.matchMedia/);
  assert.match(source, /mount\.parentElement\?\.contains\(document\.activeElement\)/);
  assert.match(source, /event\.currentTarget\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /renderer\.getPixelRatio\(\) !== pixelRatio/);
  assert.match(source, /aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight W A S D"/);
  assert.match(source, /Automatic camera movement is unavailable while reduced motion is enabled/);
  assert.match(source, /stageRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /portalReturnFocusRef/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.match(source, /window\.setTimeout\(resolve, 900\)/);
  assert.match(source, /Visible room provenance/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /inspectorTriggerRef\.current\?\.focus\(\)/);
});

test("viewer styles preserve accessible controls in narrow and reduced-motion layouts", async () => {
  const styles = await text("app/globals.css");
  assert.match(styles, /select:focus-visible/);
  assert.match(styles, /\.spatial-stage:focus-visible\s*\{[\s\S]*outline-offset: -3px/);
  assert.match(styles, /@media \(max-width: 430px\)/);
  assert.match(styles, /@media \(max-height: 560px\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.portal-gate/);
  assert.match(styles, /\.world-route/);
});

test("CPU pipeline declares generated media proxies non-metric and non-navigable", async () => {
  const source = await text("python/dgsi/pipeline.py");
  assert.match(source, /camera poses and trained 3D Gaussians were not solved/);
  assert.match(source, /"navigable": False/);
});
