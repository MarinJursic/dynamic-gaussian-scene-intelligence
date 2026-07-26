from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
import pytest
from dgsi.pipeline import STRIDE_FLOATS, ingest_capture, ingest_captures
from dgsi.sample import generate_sample
from PIL import Image


def test_sample_ingestion_is_deterministic(tmp_path: Path) -> None:
    capture = tmp_path / "capture"
    generate_sample(capture, frames=4, width=320, height=200)
    first = tmp_path / "first"
    second = tmp_path / "second"
    manifest = ingest_capture(capture, first, points_per_frame=240)
    ingest_capture(capture, second, points_per_frame=240)

    assert manifest["schema"] == "dgsi.scene/v1"
    assert manifest["point_count"] > 960
    assert manifest["source"]["image_count"] == 4
    assert manifest["source"]["video_count"] == 0
    assert manifest["spatial"]["navigable"] is False
    assert manifest["spatial"]["layout"] == "shared-camera-space"
    assert len(manifest["camera_path"]) == 4
    assert manifest["provenance"]["deterministic"] is True
    assert manifest["environment"]["projection"] == "equirectangular"
    assert manifest["environment"]["fill_strategy"] == "source-mosaic"
    assert manifest["environment"]["coverage"] == 1.0
    assert (first / "environment.jpg").read_bytes() == (second / "environment.jpg").read_bytes()
    with Image.open(first / "environment.jpg") as environment:
        assert environment.size == (2048, 1024)
    assert (first / "scene.dgsi").read_bytes() == (second / "scene.dgsi").read_bytes()
    assert (first / "scene.ply").read_text().startswith("ply\nformat ascii 1.0")

    packed = (first / "scene.dgsi").read_bytes()
    assert packed[:4] == b"DGSI"
    version, point_count, stride = struct.unpack("<III", packed[4:16])
    assert (version, point_count, stride) == (
        1,
        manifest["point_count"],
        STRIDE_FLOATS,
    )
    assert len(packed) == 16 + point_count * stride * 4
    checked_manifest = json.loads((first / "manifest.json").read_text())
    assert checked_manifest["binary_url"] == "scene.dgsi"
    assert checked_manifest["coordinate_system"]["metric_scale_known"] is False
    values = np.frombuffer(packed, dtype="<f4", offset=16).reshape(point_count, stride)
    assert np.isfinite(values).all()
    assert ((values[:, 7] >= 0) & (values[:, 7] < 5)).all()
    assert ((values[:, 10] >= 0) & (values[:, 10] <= 1)).all()
    room_points = values[: 4 * 240]
    radial_distance = np.hypot(room_points[:, 0], room_points[:, 2])
    assert 3.2 < float(np.median(radial_distance)) < 4.1
    assert room_points[:, 1].min() < -1.4
    assert room_points[:, 1].max() > 1.4
    ply_lines = (first / "scene.ply").read_text().splitlines()
    assert f"element vertex {point_count}" in ply_lines
    assert len(ply_lines[ply_lines.index("end_header") + 1 :]) == point_count


def test_unrelated_inputs_use_gallery_fallback(tmp_path: Path) -> None:
    capture = tmp_path / "unrelated"
    capture.mkdir()
    for name, color in [
        ("a.png", (245, 12, 18)),
        ("b.png", (8, 240, 22)),
        ("c.png", (15, 20, 245)),
    ]:
        Image.new("RGB", (420, 280), color).save(capture / name)
    manifest = ingest_capture(capture, tmp_path / "scene", points_per_frame=30)
    assert manifest["quality"]["reconstruction_mode"] == "gallery-fallback"
    assert manifest["spatial"]["layout"] == "circular-gallery"
    assert manifest["spatial"]["navigable"] is False
    assert len(manifest["camera_path"]) == 3
    assert any("unrelated" in warning for warning in manifest["quality"]["warnings"])


def test_single_image_and_quality_warnings(tmp_path: Path) -> None:
    source = tmp_path / "dark.png"
    Image.new("RGB", (120, 90), (2, 2, 2)).save(source)
    manifest = ingest_capture(source, tmp_path / "scene", points_per_frame=25)
    assert manifest["source"]["kind"] == "images"
    assert manifest["source"]["frame_count"] == 1
    assert manifest["source"]["file_count"] == 1
    assert manifest["source"]["image_count"] == 1
    assert manifest["source"]["video_count"] == 0
    assert manifest["point_count"] > 25
    warnings = " ".join(manifest["quality"]["warnings"])
    assert "depth and pose confidence" in warnings
    assert "below 0.16 MP" in warnings
    assert "underexposed" in warnings


def test_image_sequence_respects_max_frames(tmp_path: Path) -> None:
    capture = tmp_path / "capture"
    generate_sample(capture, frames=6, width=320, height=200)
    manifest = ingest_capture(capture, tmp_path / "scene", points_per_frame=20, max_frames=3)
    assert manifest["source"]["frame_count"] == 3
    assert manifest["point_count"] > 60
    assert len(manifest["quality"]["frames"]) == 3


def test_video_ingestion_extracts_real_frames(tmp_path: Path) -> None:
    video = Path(__file__).parents[2] / "examples" / "sample-capture.mp4"
    manifest = ingest_capture(
        video,
        tmp_path / "video-scene",
        points_per_frame=30,
        video_fps=2,
        max_frames=3,
    )
    assert manifest["source"]["kind"] == "video"
    assert 1 <= manifest["source"]["frame_count"] <= 3
    assert manifest["point_count"] > manifest["source"]["frame_count"] * 30


def test_mixed_images_and_multiple_videos_build_one_review_proxy(
    tmp_path: Path,
) -> None:
    image = tmp_path / "anchor.png"
    Image.new("RGB", (420, 280), (82, 126, 164)).save(image)
    video = Path(__file__).parents[2] / "examples" / "sample-capture.mp4"
    manifest = ingest_captures(
        [image, video, video],
        tmp_path / "mixed-space",
        points_per_frame=32,
        video_fps=2,
        max_frames=5,
    )
    assert manifest["source"]["kind"] == "mixed"
    assert manifest["source"]["image_count"] == 1
    assert manifest["source"]["video_count"] == 2
    assert manifest["source"]["file_count"] == 3
    assert manifest["source"]["frame_count"] == 5
    assert manifest["point_count"] > 5 * 32
    assert manifest["spatial"]["navigable"] is False
    assert len(manifest["camera_path"]) == 5
    extent = np.subtract(
        manifest["spatial"]["navigable_bounds"]["max"],
        manifest["spatial"]["navigable_bounds"]["min"],
    )
    assert min(extent) > 1.0


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"points_per_frame": 0}, "Points per frame"),
        ({"max_frames": 0}, "Maximum frames"),
        ({"video_fps": 0}, "Video FPS"),
    ],
)
def test_invalid_ingestion_controls_fail_cleanly(
    tmp_path: Path, kwargs: dict, message: str
) -> None:
    source = tmp_path / "source.png"
    Image.new("RGB", (200, 200), "white").save(source)
    with pytest.raises(ValueError, match=message):
        ingest_capture(source, tmp_path / "scene", **kwargs)


def test_corrupt_image_fails_with_actionable_error(tmp_path: Path) -> None:
    source = tmp_path / "broken.png"
    source.write_bytes(b"not an image")
    with pytest.raises(ValueError, match="Unreadable image"):
        ingest_capture(source, tmp_path / "scene")
