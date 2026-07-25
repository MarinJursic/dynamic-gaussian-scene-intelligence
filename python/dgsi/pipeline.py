from __future__ import annotations

import json
import math
import shutil
import struct
import subprocess
import tempfile
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageOps

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
SEMANTICS = [
    {"id": 0, "name": "Structure", "color": "#8ea0ad"},
    {"id": 1, "name": "Glazing", "color": "#65d6ff"},
    {"id": 2, "name": "People", "color": "#ffb547"},
    {"id": 3, "name": "Vegetation", "color": "#67e8a3"},
    {"id": 4, "name": "Installed work", "color": "#b58cff"},
]
STRIDE_FLOATS = 11


@dataclass(frozen=True)
class FrameMetric:
    file: str
    width: int
    height: int
    sharpness: float
    exposure: float


@dataclass(frozen=True)
class QualityReport:
    status: str
    median_relatedness: float
    frames: list[FrameMetric]
    warnings: list[str]
    reconstruction_mode: str


def _image_paths(source: Path) -> list[Path]:
    if source.is_file() and source.suffix.lower() in IMAGE_SUFFIXES:
        return [source]
    if source.is_dir():
        return sorted(
            (path for path in source.rglob("*") if path.suffix.lower() in IMAGE_SUFFIXES),
            key=lambda path: path.as_posix().lower(),
        )
    return []


def extract_video_frames(
    video: Path, output: Path, fps: float = 2.0, max_frames: int = 48
) -> list[Path]:
    if not video.is_file():
        raise ValueError(f"Video does not exist: {video}")
    if not math.isfinite(fps) or fps <= 0 or fps > 60:
        raise ValueError("Video FPS must be greater than 0 and at most 60.")
    if max_frames < 1 or max_frames > 240:
        raise ValueError("Maximum frames must be between 1 and 240.")
    output.mkdir(parents=True, exist_ok=True)
    pattern = output / "frame-%04d.jpg"
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(video),
        "-vf",
        f"fps={fps}",
        "-frames:v",
        str(max_frames),
        "-q:v",
        "2",
        str(pattern),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode:
        raise RuntimeError(f"Video extraction failed: {completed.stderr.strip()}")
    frames = _image_paths(output)
    if not frames:
        raise ValueError("The video produced no readable frames.")
    return frames


def _balanced_frames(groups: Sequence[list[Path]], max_frames: int) -> list[Path]:
    """Keep every capture represented while preserving ordering within each source."""
    populated = [group for group in groups if group]
    if not populated:
        return []
    if len(populated) > max_frames:
        raise ValueError(
            f"The capture contains {len(populated)} source groups but max_frames is {max_frames}. "
            "Increase --max-frames so every source can be represented."
        )
    allocations = [1 for _ in populated]
    remaining = max_frames - len(populated)
    while remaining:
        changed = False
        for index, group in enumerate(populated):
            if allocations[index] >= len(group):
                continue
            allocations[index] += 1
            remaining -= 1
            changed = True
            if remaining == 0:
                break
        if not changed:
            break
    return [
        frame
        for group, allocation in zip(populated, allocations, strict=True)
        for frame in group[:allocation]
    ]


def _collect_capture_frames(
    sources: Sequence[Path],
    temporary: Path,
    *,
    video_fps: float,
    max_frames: int,
) -> tuple[list[Path], dict]:
    if not sources:
        raise ValueError("Provide at least one image, image directory, or video.")

    image_paths: list[Path] = []
    video_paths: list[Path] = []
    directory_groups: list[list[Path]] = []
    asset_names: list[str] = []
    for source in sources:
        if not source.exists():
            raise ValueError(f"Capture source does not exist: {source}")
        if source.is_dir():
            paths = _image_paths(source)
            if not paths:
                raise ValueError(f"No supported images were found in: {source}")
            directory_groups.append(paths)
            asset_names.extend(path.name for path in paths)
        elif source.suffix.lower() in IMAGE_SUFFIXES:
            image_paths.append(source)
            asset_names.append(source.name)
        elif source.suffix.lower() in VIDEO_SUFFIXES:
            video_paths.append(source)
            asset_names.append(source.name)
        else:
            raise ValueError(f"Unsupported capture source: {source.name}")

    groups: list[list[Path]] = []
    if image_paths:
        groups.append(image_paths)
    groups.extend(directory_groups)
    video_limit = max(
        1,
        min(
            max_frames,
            math.ceil(max_frames / max(1, len(video_paths) + len(groups))) + 2,
        ),
    )
    video_frame_counts: list[int] = []
    for index, video in enumerate(video_paths):
        frames = extract_video_frames(
            video,
            temporary / f"video-{index:03d}",
            fps=video_fps,
            max_frames=video_limit,
        )
        groups.append(frames)
        video_frame_counts.append(len(frames))

    frames = _balanced_frames(groups, max_frames)
    if image_paths or directory_groups:
        image_count = len(image_paths) + sum(len(group) for group in directory_groups)
    else:
        image_count = 0
    if video_paths and image_count:
        kind = "mixed"
    elif len(video_paths) > 1:
        kind = "videos"
    elif video_paths:
        kind = "video"
    else:
        kind = "images"
    return frames, {
        "kind": kind,
        "frame_count": len(frames),
        "file_count": image_count + len(video_paths),
        "image_count": image_count,
        "video_count": len(video_paths),
        "asset_names": asset_names,
        "video_frame_counts": video_frame_counts,
    }


def _normalized_histogram(rgb: np.ndarray) -> np.ndarray:
    bins: list[np.ndarray] = []
    for channel in range(3):
        hist, _ = np.histogram(rgb[..., channel], bins=16, range=(0, 255))
        bins.append(hist.astype(np.float64))
    vector = np.concatenate(bins)
    norm = float(np.linalg.norm(vector))
    return vector / norm if norm else vector


def inspect_frames(paths: Iterable[Path]) -> QualityReport:
    metrics: list[FrameMetric] = []
    histograms: list[np.ndarray] = []
    thumbnails: list[np.ndarray] = []
    for path in paths:
        try:
            with Image.open(path) as image:
                image.load()
                rgb = np.asarray(image.convert("RGB").resize((192, 120)), dtype=np.float32)
                gray = rgb.mean(axis=2)
                gx = np.diff(gray, axis=1)
                gy = np.diff(gray, axis=0)
                sharpness = float((gx.var() + gy.var()) / 2.0)
                metrics.append(
                    FrameMetric(
                        file=path.name,
                        width=image.width,
                        height=image.height,
                        sharpness=round(sharpness, 2),
                        exposure=round(float(gray.mean() / 255.0), 3),
                    )
                )
                histograms.append(_normalized_histogram(rgb))
                thumbnails.append(
                    np.asarray(image.convert("RGB").resize((96, 60)), dtype=np.float32)
                )
        except (OSError, ValueError) as exc:
            raise ValueError(f"Unreadable image: {path.name}") from exc

    if not metrics:
        raise ValueError("No supported images were found.")

    probe_indices = np.linspace(
        0,
        len(histograms) - 1,
        min(24, len(histograms)),
        dtype=np.int64,
    )
    similarities = [
        float(np.dot(histograms[left], histograms[right]))
        for probe_offset, left in enumerate(probe_indices)
        for right in probe_indices[probe_offset + 1 :]
    ]
    relatedness = float(np.median(similarities)) if similarities else 1.0
    warnings: list[str] = []
    if len(metrics) < 3:
        warnings.append("Only one or two views were provided; depth and pose confidence are low.")
    if min(metric.width * metric.height for metric in metrics) < 160_000:
        warnings.append("Some frames are below 0.16 MP; small details may not survive sampling.")
    if float(np.median([metric.sharpness for metric in metrics])) < 75:
        warnings.append("The capture appears soft or motion-blurred.")
    median_exposure = float(np.median([metric.exposure for metric in metrics]))
    if median_exposure < 0.12:
        warnings.append("The capture appears strongly underexposed.")
    elif median_exposure > 0.9:
        warnings.append("The capture appears strongly overexposed.")
    if relatedness < 0.72:
        warnings.append(
            "Frames may depict unrelated content. They were preserved as a spatial gallery instead of being fused."
        )
    adjacent_differences = [
        float(np.abs(thumbnails[index] - thumbnails[index + 1]).mean() / 255.0)
        for index in range(len(thumbnails) - 1)
    ]
    if adjacent_differences and float(np.min(adjacent_differences)) < 0.002:
        warnings.append(
            "Near-duplicate frames were detected; broader viewpoint coverage is recommended."
        )
    mode = "gallery-fallback" if relatedness < 0.72 else "surrogate-reconstruction"
    status = "warning" if warnings else "ready"
    return QualityReport(status, round(relatedness, 3), metrics, warnings, mode)


def _semantic(rgb: np.ndarray) -> np.ndarray:
    red, green, blue = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    labels = np.zeros(len(rgb), dtype=np.float32)
    labels[(blue > red * 1.08) & (blue > green * 1.04)] = 1
    labels[(green > red * 1.12) & (green > blue * 1.06)] = 3
    labels[(red > 145) & (green > 70) & (green < red * 0.86) & (blue < green)] = 2
    labels[(red > 115) & (blue > green * 1.08) & (red > green * 1.03)] = 4
    return labels


def _camera_basis(
    index: int, count: int, mode: str
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    progress = index / max(1, count)
    angle = progress * math.tau
    if mode == "gallery-fallback":
        position = np.array(
            [math.sin(angle) * 4.4, 0.05, math.cos(angle) * 4.4],
            dtype=np.float32,
        )
        forward = -position
        forward[1] = 0
    else:
        position = np.array(
            [
                math.sin(angle) * 0.78,
                0.08 * math.sin(angle * 2),
                math.cos(angle) * 0.78,
            ],
            dtype=np.float32,
        )
        forward = -position
        forward[1] *= 0.2
    forward /= max(float(np.linalg.norm(forward)), 1e-6)
    right = np.array([forward[2], 0, -forward[0]], dtype=np.float32)
    right /= max(float(np.linalg.norm(right)), 1e-6)
    up = np.cross(right, forward).astype(np.float32)
    up /= max(float(np.linalg.norm(up)), 1e-6)
    return position, forward, right, up


def _frame_points(
    path: Path, index: int, count: int, mode: str, points_per_frame: int
) -> np.ndarray:
    with Image.open(path) as image:
        rgb_image = np.asarray(image.convert("RGB").resize((320, 200)), dtype=np.float32)
    height, width, _ = rgb_image.shape
    available = width * height
    candidates = np.arange(available, dtype=np.int64)
    horizontal_fov = math.radians(105)
    if mode != "gallery-fallback" and count > 1:
        # Keep one non-overlapping angular sector from every ordered view.
        # This turns an overlapping panorama/video sweep into a coherent room
        # shell instead of alpha-blending several offset views at each angle.
        columns = candidates % width
        normalized_x = columns.astype(np.float32) / (width - 1) - 0.5
        sector_half_width = min(0.5, math.pi / count / horizontal_fov)
        candidates = candidates[np.abs(normalized_x) <= sector_half_width]
    sample_count = min(points_per_frame, len(candidates))
    # A seeded permutation is deterministic without creating the diagonal
    # lattice artifacts produced by a fixed raster stride.
    rng = np.random.default_rng(0xD651 + index * 7919)
    flat_indices = rng.choice(candidates, size=sample_count, replace=False)
    y = flat_indices // width
    x = flat_indices % width
    colors = rgb_image[y, x] / 255.0
    u = x.astype(np.float32) / (width - 1) - 0.5
    v = 0.5 - y.astype(np.float32) / (height - 1)
    luminance = colors.mean(axis=1)

    position, forward, right, up = _camera_basis(index, count, mode)
    if mode == "gallery-fallback":
        # Unrelated captures become a circular, walkable gallery. They are never
        # falsely fused, but each source remains spatially inspectable.
        panel_center = position
        points = (
            panel_center[None, :]
            + right[None, :] * (u * 3.05)[:, None]
            + up[None, :] * (v * 2.15)[:, None]
            + forward[None, :] * ((luminance - 0.5) * 0.09)[:, None]
        )
        px, py, pz = points[:, 0], points[:, 1], points[:, 2]
    else:
        # Related views form an inside-facing panoramic room shell. Adjacent
        # frames overlap in angle, so a coherent capture retains recognizable
        # source color while the viewer can move within the resulting volume.
        # This remains a deterministic visualization surrogate: production
        # adapters replace it with recovered poses and optimized Gaussians.
        center_angle = index / max(1, count) * math.tau
        theta = center_angle + u * horizontal_fov
        radius = 3.65 + (0.5 - luminance) * 0.16 + 0.06 * np.sin(u * 13 + index)
        px = np.sin(theta) * radius
        pz = np.cos(theta) * radius
        py = v * 3.18

    semantic = _semantic(colors)
    size = 0.024 + (1.0 - luminance) * 0.028
    phase = (x * 0.071 + y * 0.039 + index * 0.23).astype(np.float32)
    temporal = index / max(1, count - 1)
    # Installed-work and moving-human colors carry temporal/change signals in the demo.
    change = np.where(semantic == 4, 0.45 + 0.55 * temporal, 0.0)
    change = np.where(semantic == 2, 0.25 + 0.4 * abs(temporal - 0.5), change)
    opacity = np.clip(0.58 + luminance * 0.42, 0.5, 0.98)
    return np.column_stack([px, py, pz, colors, size, semantic, phase, change, opacity]).astype(
        "<f4"
    )


def _support_points(frame_count: int, median_color: np.ndarray, mode: str) -> np.ndarray:
    """Add a subtle floor so the generated space has scale and locomotion cues."""
    count = max(360, min(1_600, frame_count * 80))
    columns = max(18, int(math.sqrt(count * 1.5)))
    rows = math.ceil(count / columns)
    gx, gz = np.meshgrid(
        np.linspace(-4.9, 4.9, columns, dtype=np.float32),
        np.linspace(-4.9, 4.9, rows, dtype=np.float32),
    )
    px = gx.ravel()[:count]
    pz = gz.ravel()[:count]
    radius = np.sqrt(px**2 + pz**2)
    limit = 5.1 if mode == "gallery-fallback" else 4.7
    mask = radius <= limit
    px, pz = px[mask], pz[mask]
    py = np.full(len(px), -1.62, dtype=np.float32)
    base = np.clip(median_color * 0.18 + np.array([0.045, 0.06, 0.052]), 0, 1)
    colors = np.tile(base.astype(np.float32), (len(px), 1))
    size = np.full(len(px), 0.055, dtype=np.float32)
    semantic = np.zeros(len(px), dtype=np.float32)
    phase = ((px * 0.13 + pz * 0.07) % 1).astype(np.float32)
    change = np.zeros(len(px), dtype=np.float32)
    opacity = np.clip(0.46 + (1 - radius[mask] / limit) * 0.2, 0.35, 0.66).astype(np.float32)
    return np.column_stack([px, py, pz, colors, size, semantic, phase, change, opacity]).astype(
        "<f4"
    )


def _write_environment(frames: Sequence[Path], output: Path, mode: str) -> dict:
    """Write a complete source-grounded 360° context texture.

    The texture prevents uncovered rays from falling through to black while
    keeping completion separate from reconstructed geometry.
    """

    width, height = 2048, 1024
    canvas = Image.new("RGB", (width, height))
    stripe_edges = np.linspace(0, width, len(frames) + 1, dtype=np.int64)
    horizontal_fov = math.radians(105)
    sector_fraction = min(1.0, (math.tau / max(1, len(frames))) / horizontal_fov)

    for index, frame in enumerate(frames):
        with Image.open(frame) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            if mode != "gallery-fallback" and len(frames) > 1:
                crop_width = max(1, round(image.width * sector_fraction))
                left = (image.width - crop_width) // 2
                image = image.crop((left, 0, left + crop_width, image.height))
            stripe_width = int(stripe_edges[index + 1] - stripe_edges[index])
            fitted = ImageOps.fit(
                image,
                (stripe_width, height),
                method=Image.Resampling.LANCZOS,
                centering=(0.5, 0.5),
            )
            canvas.paste(fitted, (int(stripe_edges[index]), 0))

    canvas.save(output, "JPEG", quality=94, subsampling=0, optimize=True)
    return {
        "url": output.name,
        "projection": "equirectangular",
        "fill_strategy": ("gallery-mosaic" if mode == "gallery-fallback" else "source-mosaic"),
        "generated": True,
        "coverage": round(min(1.0, len(frames) * horizontal_fov / math.tau), 3),
    }


def _camera_path(frame_count: int, mode: str) -> list[dict]:
    keyframes: list[dict] = []
    for index in range(max(2, frame_count)):
        source_index = min(index, max(0, frame_count - 1))
        position, forward, _, _ = _camera_basis(source_index, max(1, frame_count), mode)
        if mode == "gallery-fallback":
            position = position * np.array([0.46, 1, 0.46], dtype=np.float32)
            target = position + forward * 3.0
        else:
            target = position + forward * 2.4
        keyframes.append(
            {
                "time": round(index / max(1, max(2, frame_count) - 1), 5),
                "position": position.round(4).tolist(),
                "target": target.round(4).tolist(),
                "fov": 58,
            }
        )
    return keyframes


def _write_binary(path: Path, points: np.ndarray) -> None:
    with path.open("wb") as stream:
        stream.write(b"DGSI")
        stream.write(struct.pack("<III", 1, len(points), STRIDE_FLOATS))
        stream.write(points.astype("<f4", copy=False).tobytes())


def _write_ply(path: Path, points: np.ndarray) -> None:
    rgb = np.clip(points[:, 3:6] * 255, 0, 255).astype(np.uint8)
    header = (
        "ply\nformat ascii 1.0\n"
        f"element vertex {len(points)}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        "property float scale\nproperty uchar semantic\n"
        "property float motion_phase\nproperty float change\nproperty float opacity\n"
        "end_header\n"
    )
    with path.open("w", encoding="utf-8") as stream:
        stream.write(header)
        for point, color in zip(points, rgb, strict=True):
            stream.write(
                f"{point[0]:.5f} {point[1]:.5f} {point[2]:.5f} "
                f"{color[0]} {color[1]} {color[2]} {point[6]:.5f} "
                f"{int(point[7])} {point[8]:.5f} {point[9]:.5f} {point[10]:.5f}\n"
            )


def ingest_captures(
    sources: Sequence[str | Path],
    output: str | Path,
    *,
    points_per_frame: int = 1800,
    video_fps: float = 2.0,
    max_frames: int = 48,
) -> dict:
    if points_per_frame < 1 or points_per_frame > 16_000:
        raise ValueError("Points per frame must be between 1 and 16,000.")
    if max_frames < 1 or max_frames > 240:
        raise ValueError("Maximum frames must be between 1 and 240.")
    if not math.isfinite(video_fps) or video_fps <= 0 or video_fps > 60:
        raise ValueError("Video FPS must be greater than 0 and at most 60.")
    source_paths = [Path(source).expanduser().resolve() for source in sources]
    output_path = Path(output).expanduser().resolve()

    with tempfile.TemporaryDirectory(prefix="dgsi-frames-") as temp_dir:
        frames, source_summary = _collect_capture_frames(
            source_paths,
            Path(temp_dir),
            video_fps=video_fps,
            max_frames=max_frames,
        )
        report = inspect_frames(frames)
        clouds = [
            _frame_points(path, index, len(frames), report.reconstruction_mode, points_per_frame)
            for index, path in enumerate(frames)
        ]
        frame_colors: list[np.ndarray] = []
        for path in frames:
            with Image.open(path) as image:
                frame_colors.append(
                    np.asarray(image.convert("RGB").resize((1, 1)), dtype=np.float32)[0, 0] / 255.0
                )
        median_color = np.median(np.stack(frame_colors), axis=0)
        clouds.append(_support_points(len(frames), median_color, report.reconstruction_mode))
        points = np.concatenate(clouds, axis=0)
        output_path.mkdir(parents=True, exist_ok=True)
        _write_binary(output_path / "scene.dgsi", points)
        _write_ply(output_path / "scene.ply", points)
        environment = _write_environment(
            frames,
            output_path / "environment.jpg",
            report.reconstruction_mode,
        )
        report_dict = asdict(report)
        camera_path = _camera_path(len(frames), report.reconstruction_mode)
        bounds_min = points[:, :3].min(axis=0)
        bounds_max = points[:, :3].max(axis=0)
        navigation_margin = np.array([0.55, 0.25, 0.55], dtype=np.float32)
        entry = camera_path[0]
        manifest = {
            "schema": "dgsi.scene/v1",
            "title": (
                source_paths[0].stem.replace("-", " ").title()
                if len(source_paths) == 1
                else f"Unified Space · {len(source_paths)} Captures"
            ),
            "description": (
                "Navigable CPU Gaussian-style spatial surrogate reconstructed "
                "from all supplied images and videos."
            ),
            "source": source_summary,
            "point_count": int(len(points)),
            "stride_floats": STRIDE_FLOATS,
            "binary_url": "scene.dgsi",
            "ply_url": "scene.ply",
            "environment": environment,
            "progressive_chunks": [0.18, 0.42, 0.7, 1.0],
            "bounds": {
                "min": bounds_min.round(4).tolist(),
                "max": bounds_max.round(4).tolist(),
            },
            "semantics": SEMANTICS,
            "timeline": {"duration_seconds": 12, "comparison_label": "Week 12 → Week 18"},
            "coordinate_system": {"units": "scene-units", "metric_scale_known": False},
            "spatial": {
                "layout": (
                    "circular-gallery"
                    if report.reconstruction_mode == "gallery-fallback"
                    else "shared-camera-space"
                ),
                "navigable": True,
                "floor_height": -1.62,
                "navigable_bounds": {
                    "min": (bounds_min - navigation_margin).round(4).tolist(),
                    "max": (bounds_max + navigation_margin).round(4).tolist(),
                },
                "entry_pose": {
                    "position": entry["position"],
                    "target": entry["target"],
                },
            },
            "camera_path": camera_path,
            "quality": report_dict,
            "provenance": {
                "pipeline": "dgsi-cpu-surrogate/0.1.0",
                "deterministic": True,
                "production_gaussian_optimized": False,
            },
        }
        (output_path / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return manifest


def ingest_capture(
    source: str | Path,
    output: str | Path,
    *,
    points_per_frame: int = 1800,
    video_fps: float = 2.0,
    max_frames: int = 48,
) -> dict:
    """Backward-compatible single-source entry point."""
    return ingest_captures(
        [source],
        output,
        points_per_frame=points_per_frame,
        video_fps=video_fps,
        max_frames=max_frames,
    )


def copy_scene(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("manifest.json", "scene.dgsi", "scene.ply", "environment.jpg"):
        if not (source / name).exists():
            continue
        shutil.copy2(source / name, destination / name)
