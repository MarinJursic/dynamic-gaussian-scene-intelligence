from __future__ import annotations

import io
from pathlib import Path

from dgsi.api import app
from fastapi.testclient import TestClient
from PIL import Image


def _png_bytes(color: tuple[int, int, int]) -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (420, 280), color).save(stream, format="PNG")
    return stream.getvalue()


def test_health() -> None:
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_configured_viewer_origin_receives_cors_headers() -> None:
    response = TestClient(app).get(
        "/health",
        headers={"Origin": "http://localhost:3106"},
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3106"


def test_image_sequence_upload() -> None:
    client = TestClient(app)
    files = [
        ("files", ("a.png", _png_bytes((80, 120, 160)), "image/png")),
        ("files", ("b.png", _png_bytes((88, 124, 166)), "image/png")),
        ("files", ("c.png", _png_bytes((92, 128, 171)), "image/png")),
    ]
    response = client.post("/api/ingest", files=files)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["point_count"] > 5400
    assert body["source"]["image_count"] == 3
    assert body["source"]["video_count"] == 0
    assert body["spatial"]["navigable"] is False
    assert body["scene_url"].endswith("/manifest.json")
    scene_path = "/" + body["scene_url"].split("/", 3)[-1]
    manifest_response = client.get(scene_path)
    assert manifest_response.status_code == 200
    manifest = manifest_response.json()
    binary_response = client.get(scene_path.replace("manifest.json", manifest["binary_url"]))
    assert binary_response.status_code == 200
    assert binary_response.content[:4] == b"DGSI"
    assert client.get(scene_path.replace("manifest.json", "missing.dgsi")).status_code == 404


def test_mixed_image_and_video_upload_builds_one_scene() -> None:
    client = TestClient(app)
    video = (Path(__file__).parents[2] / "examples" / "sample-capture.mp4").read_bytes()
    response = client.post(
        "/api/ingest",
        files=[
            ("files", ("anchor.png", _png_bytes((80, 120, 160)), "image/png")),
            ("files", ("walkthrough.mp4", video, "video/mp4")),
        ],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["source"]["kind"] == "mixed"
    assert body["source"]["image_count"] == 1
    assert body["source"]["video_count"] == 1
    assert body["source"]["frame_count"] > 1
    assert body["spatial"]["layout"] in {"shared-camera-space", "circular-gallery"}
    scene_path = "/" + body["scene_url"].split("/", 3)[-1]
    manifest = client.get(scene_path).json()
    assert manifest["camera_path"]
    assert manifest["spatial"]["navigable"] is False


def test_rejects_unsupported_corrupt_and_empty_uploads() -> None:
    client = TestClient(app)
    unsupported = client.post(
        "/api/ingest", files=[("files", ("notes.txt", b"text", "text/plain"))]
    )
    assert unsupported.status_code == 415

    corrupt = client.post("/api/ingest", files=[("files", ("broken.png", b"not-png", "image/png"))])
    assert corrupt.status_code == 422
    assert "Unreadable image" in corrupt.json()["detail"]

    empty = client.post("/api/ingest", files=[("files", ("empty.png", b"", "image/png"))])
    assert empty.status_code == 422
    assert "Empty upload" in empty.json()["detail"]

    corrupt_video = client.post(
        "/api/ingest",
        files=[("files", ("video.mp4", b"fake", "video/mp4"))],
    )
    assert corrupt_video.status_code == 422
    assert "Video extraction failed" in corrupt_video.json()["detail"]
