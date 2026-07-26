import assert from "node:assert/strict";
import test from "node:test";

import { decodeDgsi, validateManifest } from "../app/scene-format.ts";

const manifest = {
  schema: "dgsi.scene/v1",
  title: "Fixture",
  description: "Decoder fixture",
  source: {
    kind: "mixed",
    frame_count: 3,
    file_count: 2,
    image_count: 1,
    video_count: 1,
  },
  point_count: 2,
  stride_floats: 11,
  binary_url: "scene.dgsi",
  ply_url: "scene.ply",
  environment: {
    url: "environment.jpg",
    projection: "equirectangular",
    fill_strategy: "source-mosaic",
    generated: true,
    coverage: 0.75,
  },
  progressive_chunks: [0.5, 1],
  bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
  semantics: [
    { id: 0, name: "Structure", color: "#8ea0ad" },
    { id: 1, name: "Glazing", color: "#65d6ff" },
  ],
  timeline: { duration_seconds: 12, comparison_label: "A → B" },
  coordinate_system: { units: "scene-units", metric_scale_known: false },
  spatial: {
    layout: "shared-camera-space",
    navigable: true,
    floor_height: -1.62,
    navigable_bounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    entry_pose: { position: [0, 0, 1], target: [0, 0, 0] },
  },
  camera_path: [
    { time: 0, position: [0, 0, 1], target: [0, 0, 0], fov: 58 },
    { time: 1, position: [1, 0, 0], target: [0, 0, 0], fov: 58 },
  ],
  quality: {
    status: "ready",
    median_relatedness: 1,
    reconstruction_mode: "surrogate-reconstruction",
    warnings: [],
  },
  provenance: {
    pipeline: "test",
    deterministic: true,
    production_gaussian_optimized: false,
  },
} as const;

function fixtureBinary() {
  const rows = [
    0, 1, 2, 0.1, 0.2, 0.3, 0.04, 0, 0.2, 0, 0.8,
    3, 4, 5, 0.4, 0.5, 0.6, 0.05, 1, 0.4, 0.7, 0.9,
  ];
  const buffer = new ArrayBuffer(16 + rows.length * 4);
  const view = new DataView(buffer);
  new Uint8Array(buffer, 0, 4).set([68, 71, 83, 73]);
  view.setUint32(4, 1, true);
  view.setUint32(8, 2, true);
  view.setUint32(12, 11, true);
  new Float32Array(buffer, 16).set(rows);
  return buffer;
}

test("validates and decodes the complete DGSI v1 contract", () => {
  const checked = validateManifest(manifest);
  const decoded = decodeDgsi(fixtureBinary(), checked);
  assert.equal(decoded.count, 2);
  assert.deepEqual(decoded.semanticCounts, [1, 1]);
  assert.equal(decoded.changedCount, 1);
  assert.equal(decoded.uncertainCount, 0);
  assert.ok(Math.abs(decoded.meanChange - 0.35) < 1e-6);
  assert.deepEqual(Array.from(decoded.positions), [0, 1, 2, 3, 4, 5]);
});

test("accepts an explicitly non-navigable review proxy", () => {
  const checked = validateManifest({
    ...manifest,
    spatial: { ...manifest.spatial, navigable: false },
  });
  assert.equal(checked.spatial.navigable, false);
});

test("rejects manifest/binary disagreement and malformed progressive chunks", () => {
  const badCount = validateManifest({ ...manifest, point_count: 3 });
  assert.throws(() => decodeDgsi(fixtureBinary(), badCount), /does not match/);
  assert.throws(
    () => validateManifest({ ...manifest, progressive_chunks: [0.7, 0.4, 1] }),
    /progressive chunks/,
  );
  assert.throws(
    () => validateManifest({
      ...manifest,
      camera_path: [
        manifest.camera_path[0],
        { ...manifest.camera_path[1], time: 0 },
      ],
    }),
    /camera path/,
  );
  assert.throws(
    () => validateManifest({
      ...manifest,
      environment: { ...manifest.environment, coverage: 1.2 },
    }),
    /environment completion/,
  );
});

test("rejects non-finite and out-of-contract point attributes", () => {
  const binary = fixtureBinary();
  new Float32Array(binary, 16)[10] = 1.5;
  assert.throws(() => decodeDgsi(binary, validateManifest(manifest)), /invalid scale, opacity, or change/);
});
