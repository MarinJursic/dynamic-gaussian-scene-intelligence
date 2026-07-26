from __future__ import annotations

import os
import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .pipeline import IMAGE_SUFFIXES, VIDEO_SUFFIXES, ingest_captures

SCENE_ROOT = Path(os.getenv("DGSI_SCENE_ROOT", "runtime-scenes")).resolve()
MAX_UPLOAD_BYTES = int(os.getenv("DGSI_MAX_UPLOAD_BYTES", str(256 * 1024 * 1024)))
MAX_UPLOAD_FILES = int(os.getenv("DGSI_MAX_UPLOAD_FILES", "32"))
MAX_BATCH_BYTES = int(os.getenv("DGSI_MAX_BATCH_BYTES", str(1024 * 1024 * 1024)))
DEFAULT_ORIGINS = (
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost:3001,http://127.0.0.1:3001,"
    "http://localhost:3106,http://127.0.0.1:3106"
)
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("DGSI_ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",")
    if origin.strip()
]
ALLOWED_ORIGIN_REGEX = os.getenv(
    "DGSI_ALLOWED_ORIGIN_REGEX",
    r"https://(?:[a-z0-9-]+\.)?(?:github\.io|openai\.site)$",
)
SCENE_ROOT.mkdir(parents=True, exist_ok=True)
app = FastAPI(
    title="DGSI Ingestion API",
    version="0.1.0",
    description="CPU reference ingestion for image sequences and video captures.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "pipeline": "dgsi-cpu-surrogate/0.1.0"}


@app.post("/api/ingest")
async def ingest(request: Request, files: list[UploadFile] = File(...)) -> dict:
    if not files:
        raise HTTPException(
            status_code=400,
            detail="Upload one or more images and videos.",
        )
    if len(files) > MAX_UPLOAD_FILES:
        raise HTTPException(
            status_code=413,
            detail=f"A capture batch can contain at most {MAX_UPLOAD_FILES} files.",
        )
    job_id = uuid.uuid4().hex[:12]
    output = SCENE_ROOT / job_id
    with tempfile.TemporaryDirectory(prefix="dgsi-upload-") as temporary:
        upload_dir = Path(temporary)
        saved: list[Path] = []
        total_written = 0
        for index, upload in enumerate(files):
            suffix = Path(upload.filename or "").suffix.lower()
            if suffix not in IMAGE_SUFFIXES | VIDEO_SUFFIXES:
                raise HTTPException(status_code=415, detail=f"Unsupported file: {upload.filename}")
            target = upload_dir / f"{index:03d}-{Path(upload.filename or 'capture').name}"
            written = 0
            with target.open("wb") as stream:
                while chunk := upload.file.read(1024 * 1024):
                    written += len(chunk)
                    if written > MAX_UPLOAD_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=f"Upload exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB limit.",
                        )
                    total_written += len(chunk)
                    if total_written > MAX_BATCH_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=(
                                "Capture batch exceeds the "
                                f"{MAX_BATCH_BYTES // (1024 * 1024)} MiB limit."
                            ),
                        )
                    stream.write(chunk)
            if written == 0:
                raise HTTPException(status_code=422, detail=f"Empty upload: {upload.filename}")
            saved.append(target)
        try:
            manifest = ingest_captures(saved, output)
        except (ValueError, RuntimeError, OSError) as exc:
            shutil.rmtree(output, ignore_errors=True)
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    scene_url = str(request.base_url).rstrip("/") + f"/scenes/{job_id}/manifest.json"
    return {
        "job_id": job_id,
        "scene_url": scene_url,
        "quality": manifest["quality"],
        "point_count": manifest["point_count"],
        "source": manifest["source"],
        "spatial": manifest["spatial"],
    }


app.mount("/scenes", StaticFiles(directory=SCENE_ROOT), name="scenes")
