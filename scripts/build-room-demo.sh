#!/usr/bin/env bash
set -euo pipefail

.venv/bin/dgsi ingest public/room-inputs \
  --output public/room-demo \
  --points-per-frame 9000 \
  --max-frames 12

ffmpeg \
  -loglevel error \
  -y \
  -i public/captures/eso-guesthouse/context.jpg \
  -q:v 2 \
  public/room-demo/environment.jpg
node --input-type=module -e '
  import fs from "node:fs";
  const path = "public/room-demo/manifest.json";
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.title = "ESO Guesthouse · 360 Capture";
  manifest.description = "Observed ESO 360 panorama with a deterministic CPU inspection proxy. The hosted scene is not a trained 3D Gaussian Splat.";
  manifest.environment = {
    url: "environment.jpg",
    projection: "equirectangular",
    fill_strategy: "source-panorama",
    generated: false,
    coverage: 1,
  };
  manifest.spatial.layout = "single-center-360-context";
  manifest.spatial.navigable = true;
  manifest.spatial.navigable_bounds = {
    min: [-0.42, -0.18, -0.54],
    max: [0.42, 0.18, 0.24]
  };
  manifest.spatial.entry_pose = {
    position: [0, 0, 0],
    target: [0, 0, -1]
  };
  manifest.quality.reconstruction_mode = "panorama-context-with-cpu-proxy";
  manifest.quality.warnings = [
    "The hosted scene is a photographic context projection, not optimized 3DGS.",
    "Import a trained SPZ to inspect anisotropic scales, rotations, opacity, and spherical harmonics."
  ];
  manifest.provenance = {
    pipeline: "dgsi-cpu-surrogate/0.1.0",
    deterministic: true,
    production_gaussian_optimized: false,
    source_title: "Guesthouse living room (gh-livingroom-pan)",
    source_author: "European Southern Observatory",
    source_url: "https://commons.wikimedia.org/wiki/File:Guesthouse_living_room_(gh-livingroom-pan).jpg",
    source_license: "CC BY 4.0"
  };
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
'

echo "Built the ESO photographic context scene and its explicit CPU inspection proxy."
