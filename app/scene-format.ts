export type SceneManifest = {
  schema: "dgsi.scene/v1";
  title: string;
  description: string;
  source: {
    kind: "images" | "video" | "videos" | "mixed";
    frame_count: number;
    file_count: number;
    image_count: number;
    video_count: number;
    asset_names?: string[];
    video_frame_counts?: number[];
  };
  point_count: number;
  stride_floats: number;
  binary_url: string;
  ply_url: string;
  environment?: {
    url: string;
    projection: "equirectangular";
    fill_strategy: "source-panorama" | "source-mosaic" | "gallery-mosaic";
    generated: boolean;
    coverage: number;
  };
  progressive_chunks: number[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  semantics: { id: number; name: string; color: string }[];
  timeline: { duration_seconds: number; comparison_label: string };
  coordinate_system?: { units: string; metric_scale_known: boolean };
  spatial: {
    layout: "shared-camera-space" | "circular-gallery" | "single-center-360-context";
    navigable: boolean;
    floor_height: number;
    navigable_bounds: {
      min: [number, number, number];
      max: [number, number, number];
    };
    entry_pose: {
      position: [number, number, number];
      target: [number, number, number];
    };
  };
  camera_path: Array<{
    time: number;
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
  }>;
  quality: {
    status: string;
    median_relatedness: number;
    reconstruction_mode: string;
    warnings: string[];
  };
  provenance: {
    pipeline: string;
    deterministic: boolean;
    production_gaussian_optimized: boolean;
  };
};

export type DecodedScene = {
  count: number;
  stride: number;
  positions: Float32Array;
  colors: Float32Array;
  scales: Float32Array;
  semantics: Float32Array;
  phases: Float32Array;
  changes: Float32Array;
  opacities: Float32Array;
  semanticCounts: number[];
  changedCount: number;
  uncertainCount: number;
  meanChange: number;
};

function isFiniteVector(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

export function validateManifest(value: unknown): SceneManifest {
  if (!value || typeof value !== "object") throw new Error("Manifest must be a JSON object.");
  const manifest = value as Partial<SceneManifest>;
  if (manifest.schema !== "dgsi.scene/v1") throw new Error("Unsupported scene manifest schema.");
  if (!manifest.title || typeof manifest.title !== "string") throw new Error("Manifest title is missing.");
  if (
    !Number.isSafeInteger(manifest.point_count) ||
    (manifest.point_count ?? 0) < 1 ||
    (manifest.point_count ?? 0) > 10_000_000
  ) {
    throw new Error("Manifest point count is invalid.");
  }
  if (!Number.isInteger(manifest.stride_floats) || (manifest.stride_floats ?? 0) < 11) {
    throw new Error("Manifest stride is invalid.");
  }
  if (typeof manifest.binary_url !== "string" || !manifest.binary_url) {
    throw new Error("Manifest binary URL is missing.");
  }
  if (
    typeof manifest.ply_url !== "string" ||
    !manifest.ply_url ||
    !manifest.source ||
    !["images", "video", "videos", "mixed"].includes(manifest.source.kind) ||
    !Number.isSafeInteger(manifest.source.frame_count) ||
    manifest.source.frame_count < 1 ||
    !Number.isSafeInteger(manifest.source.file_count) ||
    manifest.source.file_count < 1 ||
    !Number.isSafeInteger(manifest.source.image_count) ||
    manifest.source.image_count < 0 ||
    !Number.isSafeInteger(manifest.source.video_count) ||
    manifest.source.video_count < 0 ||
    manifest.source.image_count + manifest.source.video_count !== manifest.source.file_count
  ) {
    throw new Error("Manifest source or PLY metadata is invalid.");
  }
  if (
    manifest.environment !== undefined &&
    (
      typeof manifest.environment.url !== "string" ||
      !manifest.environment.url ||
      manifest.environment.projection !== "equirectangular" ||
      !["source-panorama", "source-mosaic", "gallery-mosaic"].includes(
        manifest.environment.fill_strategy,
      ) ||
      typeof manifest.environment.generated !== "boolean" ||
      !Number.isFinite(manifest.environment.coverage) ||
      manifest.environment.coverage < 0 ||
      manifest.environment.coverage > 1
    )
  ) {
    throw new Error("Manifest environment completion metadata is invalid.");
  }
  if (!manifest.bounds || !isFiniteVector(manifest.bounds.min) || !isFiniteVector(manifest.bounds.max)) {
    throw new Error("Manifest bounds are invalid.");
  }
  if (
    !Array.isArray(manifest.semantics) ||
    manifest.semantics.length < 1 ||
    manifest.semantics.some(
      (item, index) =>
        item.id !== index || typeof item.name !== "string" || !/^#[0-9a-f]{6}$/i.test(item.color),
    )
  ) {
    throw new Error("Manifest semantic definitions are invalid.");
  }
  if (
    !manifest.timeline ||
    !Number.isFinite(manifest.timeline.duration_seconds) ||
    manifest.timeline.duration_seconds <= 0 ||
    typeof manifest.timeline.comparison_label !== "string"
  ) {
    throw new Error("Manifest timeline is invalid.");
  }
  if (
    !manifest.spatial ||
    !["shared-camera-space", "circular-gallery", "single-center-360-context"].includes(
      manifest.spatial.layout,
    ) ||
    typeof manifest.spatial.navigable !== "boolean" ||
    !Number.isFinite(manifest.spatial.floor_height) ||
    !isFiniteVector(manifest.spatial.navigable_bounds?.min) ||
    !isFiniteVector(manifest.spatial.navigable_bounds?.max) ||
    !isFiniteVector(manifest.spatial.entry_pose?.position) ||
    !isFiniteVector(manifest.spatial.entry_pose?.target)
  ) {
    throw new Error("Manifest spatial navigation metadata is invalid.");
  }
  if (
    !Array.isArray(manifest.camera_path) ||
    manifest.camera_path.length < 2 ||
    manifest.camera_path.some(
      (keyframe, index) =>
        !Number.isFinite(keyframe.time) ||
        keyframe.time < 0 ||
        keyframe.time > 1 ||
        (index > 0 && keyframe.time <= manifest.camera_path![index - 1].time) ||
        !isFiniteVector(keyframe.position) ||
        !isFiniteVector(keyframe.target) ||
        !Number.isFinite(keyframe.fov) ||
        keyframe.fov < 20 ||
        keyframe.fov > 120,
    )
  ) {
    throw new Error("Manifest camera path is invalid.");
  }
  if (
    !manifest.quality ||
    typeof manifest.quality.status !== "string" ||
    typeof manifest.quality.reconstruction_mode !== "string" ||
    !Number.isFinite(manifest.quality.median_relatedness) ||
    !Array.isArray(manifest.quality.warnings) ||
    manifest.quality.warnings.some((warning) => typeof warning !== "string") ||
    !manifest.provenance ||
    typeof manifest.provenance.pipeline !== "string" ||
    typeof manifest.provenance.deterministic !== "boolean" ||
    typeof manifest.provenance.production_gaussian_optimized !== "boolean"
  ) {
    throw new Error("Manifest quality or provenance metadata is invalid.");
  }
  const chunks = manifest.progressive_chunks;
  if (
    !Array.isArray(chunks) ||
    chunks.length < 1 ||
    chunks.some((chunk, index) => chunk <= 0 || chunk > 1 || (index > 0 && chunk <= chunks[index - 1])) ||
    chunks.at(-1) !== 1
  ) {
    throw new Error("Manifest progressive chunks are invalid.");
  }
  return manifest as SceneManifest;
}

export function decodeDgsi(buffer: ArrayBuffer, manifest: SceneManifest): DecodedScene {
  if (buffer.byteLength < 16) throw new Error("Truncated DGSI binary header.");
  const view = new DataView(buffer);
  const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  const version = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  const stride = view.getUint32(12, true);
  if (magic !== "DGSI" || version !== 1 || stride < 11) throw new Error("Unsupported DGSI binary.");
  if (count !== manifest.point_count || stride !== manifest.stride_floats) {
    throw new Error("DGSI binary does not match its manifest.");
  }
  const expectedLength = 16 + count * stride * 4;
  if (!Number.isSafeInteger(expectedLength) || buffer.byteLength !== expectedLength) {
    throw new Error("Truncated or oversized DGSI binary.");
  }

  const packed = new Float32Array(buffer, 16);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const semantics = new Float32Array(count);
  const phases = new Float32Array(count);
  const changes = new Float32Array(count);
  const opacities = new Float32Array(count);
  const semanticCounts = Array.from({ length: manifest.semantics.length }, () => 0);
  let changedCount = 0;
  let uncertainCount = 0;
  let totalChange = 0;

  for (let index = 0; index < count; index += 1) {
    const offset = index * stride;
    const row = packed.subarray(offset, offset + 11);
    if (row.some((value) => !Number.isFinite(value))) throw new Error("DGSI binary contains non-finite values.");
    positions.set(row.subarray(0, 3), index * 3);
    colors.set(row.subarray(3, 6), index * 3);
    scales[index] = row[6];
    semantics[index] = row[7];
    phases[index] = row[8];
    changes[index] = row[9];
    opacities[index] = row[10];
    const semantic = Math.round(row[7]);
    if (semantic < 0 || semantic >= semanticCounts.length) {
      throw new Error("DGSI binary contains an unknown semantic ID.");
    }
    if (row[6] <= 0 || row[10] < 0 || row[10] > 1 || row[9] < 0 || row[9] > 1) {
      throw new Error("DGSI binary contains invalid scale, opacity, or change data.");
    }
    semanticCounts[semantic] += 1;
    if (row[9] >= 0.25) changedCount += 1;
    else if (row[9] > 0) uncertainCount += 1;
    totalChange += row[9];
  }

  return {
    count,
    stride,
    positions,
    colors,
    scales,
    semantics,
    phases,
    changes,
    opacities,
    semanticCounts,
    changedCount,
    uncertainCount,
    meanChange: totalChange / count,
  };
}
