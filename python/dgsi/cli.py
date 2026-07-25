from __future__ import annotations

import argparse
import json
from pathlib import Path

from .pipeline import ingest_captures
from .sample import generate_sample


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dgsi", description="Inspect and package images/video into a DGSI browser scene."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    ingest = subparsers.add_parser(
        "ingest",
        help="Ingest one or more images, image directories, and videos into one space.",
    )
    ingest.add_argument("sources", type=Path, nargs="+")
    ingest.add_argument("--output", "-o", type=Path, required=True)
    ingest.add_argument("--points-per-frame", type=int, default=1800)
    ingest.add_argument("--video-fps", type=float, default=2.0)
    ingest.add_argument("--max-frames", type=int, default=48)

    sample = subparsers.add_parser("sample", help="Generate the deterministic sample capture.")
    sample.add_argument("--output", "-o", type=Path, required=True)
    sample.add_argument("--frames", type=int, default=12)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "sample":
        paths = generate_sample(args.output, args.frames)
        print(json.dumps({"frames": len(paths), "output": str(args.output.resolve())}, indent=2))
        return
    manifest = ingest_captures(
        args.sources,
        args.output,
        points_per_frame=args.points_per_frame,
        video_fps=args.video_fps,
        max_frames=args.max_frames,
    )
    print(
        json.dumps(
            {
                "scene": str((args.output / "manifest.json").resolve()),
                "points": manifest["point_count"],
                "mode": manifest["quality"]["reconstruction_mode"],
                "warnings": manifest["quality"]["warnings"],
                "source": manifest["source"],
                "spatial_layout": manifest["spatial"]["layout"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
