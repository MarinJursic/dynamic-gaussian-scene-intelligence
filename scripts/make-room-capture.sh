#!/usr/bin/env bash
set -euo pipefail

source_image="${1:-examples/room-panorama/living-room-panorama.png}"
output_dir="${2:-examples/room-capture}"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required to derive the room capture views." >&2
  exit 1
fi

if [[ ! -f "$source_image" ]]; then
  echo "Panorama not found: $source_image" >&2
  exit 1
fi

mkdir -p "$output_dir"
yaws=(-165 -135 -105 -75 -45 -15 15 45 75 105 135 165)

for index in "${!yaws[@]}"; do
  ffmpeg \
    -loglevel error \
    -y \
    -i "$source_image" \
    -vf "v360=input=equirect:output=flat:yaw=${yaws[$index]}:pitch=-2:h_fov=105:v_fov=74:w=960:h=640" \
    -frames:v 1 \
    "$output_dir/room-$(printf '%02d' "$index").png"
done

echo "Created ${#yaws[@]} overlapping room views in $output_dir"
