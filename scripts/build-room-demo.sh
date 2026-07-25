#!/usr/bin/env bash
set -euo pipefail

./scripts/make-room-capture.sh
.venv/bin/dgsi ingest examples/room-capture \
  --output public/room-demo \
  --points-per-frame 9000 \
  --max-frames 12

ffmpeg \
  -loglevel error \
  -y \
  -i examples/room-panorama/living-room-panorama.png \
  -q:v 2 \
  public/room-demo/environment.jpg
node --input-type=module -e '
  import fs from "node:fs";
  const path = "public/room-demo/manifest.json";
  const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
  manifest.title = "Room Capture";
  manifest.environment = {
    url: "environment.jpg",
    projection: "equirectangular",
    fill_strategy: "source-panorama",
    generated: true,
    coverage: 1,
  };
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
'

echo "Built the room scene with a complete source-grounded 360 degree environment."
