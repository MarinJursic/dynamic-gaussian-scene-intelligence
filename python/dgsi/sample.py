from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter


def generate_sample(
    output: str | Path, frames: int = 12, width: int = 640, height: int = 400
) -> list[Path]:
    """Generate a tiny, deterministic multi-view construction-atrium capture."""
    destination = Path(output)
    destination.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for index in range(frames):
        image = Image.new("RGB", (width, height), "#101a22")
        pixels = image.load()
        shift = (index - (frames - 1) / 2) * 4
        for y in range(height):
            for x in range(width):
                horizon = y / height
                glow = max(
                    0.0, 1.0 - math.hypot((x - width * 0.54) / width, (y - height * 0.30) / height)
                )
                pixels[x, y] = (
                    int(18 + 26 * glow + 16 * horizon),
                    int(28 + 37 * glow + 22 * horizon),
                    int(36 + 48 * glow + 28 * horizon),
                )
        draw = ImageDraw.Draw(image, "RGBA")
        # Floor, skylight, columns, and glass create stable overlap across views.
        draw.polygon([(0, 250), (width, 215), (width, height), (0, height)], fill=(45, 54, 57, 255))
        for band in range(10):
            y = 250 + band * 18
            draw.line((0, y, width, y - 26), fill=(108, 118, 116, 30), width=1)
        draw.polygon(
            [(190 + shift, 25), (475 + shift, 18), (420 + shift, 145), (230 + shift, 152)],
            fill=(75, 177, 214, 185),
            outline=(170, 233, 255, 220),
            width=3,
        )
        for column in (105, 260, 430, 565):
            x = column + shift * (column / width - 0.5)
            draw.polygon(
                [(x - 14, 90), (x + 14, 88), (x + 25, 310), (x - 23, 315)],
                fill=(120, 132, 139, 255),
            )
            draw.line((x - 10, 96, x - 17, 300), fill=(215, 226, 229, 100), width=4)
        # New violet installation grows over time for date-change mode.
        install_width = int(24 + index * 5.5)
        draw.rounded_rectangle(
            (345 + shift, 177, 345 + shift + install_width, 212),
            radius=6,
            fill=(152, 83, 208, 240),
            outline=(212, 169, 255, 255),
            width=2,
        )
        # A moving orange worker carries a dynamic semantic.
        worker_x = 105 + index * 30
        worker_y = 250 + int(math.sin(index * 0.7) * 7)
        draw.ellipse(
            (worker_x - 8, worker_y - 42, worker_x + 8, worker_y - 26), fill=(245, 179, 87, 255)
        )
        draw.polygon(
            [
                (worker_x - 15, worker_y - 27),
                (worker_x + 15, worker_y - 27),
                (worker_x + 11, worker_y + 14),
                (worker_x - 11, worker_y + 14),
            ],
            fill=(236, 128, 35, 255),
        )
        draw.line(
            (worker_x - 7, worker_y + 12, worker_x - 12, worker_y + 38),
            fill=(35, 43, 48, 255),
            width=6,
        )
        draw.line(
            (worker_x + 7, worker_y + 12, worker_x + 13, worker_y + 38),
            fill=(35, 43, 48, 255),
            width=6,
        )
        # Green plants provide a third clearly separable semantic.
        for plant_x in (55, 590):
            for leaf in range(7):
                angle = leaf * 0.8 + index * 0.01
                draw.line(
                    (
                        plant_x,
                        300,
                        plant_x + math.cos(angle) * 27,
                        270 + math.sin(angle) * 20,
                    ),
                    fill=(70, 210, 143, 235),
                    width=6,
                )
        image = ImageEnhance.Contrast(image).enhance(1.08)
        image = image.filter(ImageFilter.GaussianBlur(radius=0.25))
        path = destination / f"atrium-{index:03d}.png"
        image.save(path, optimize=True)
        paths.append(path)
    return paths
