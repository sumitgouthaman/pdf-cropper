"""PDF Cropper — FastAPI backend."""

from __future__ import annotations

import asyncio
import io
import os
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF
import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="PDF Cropper")

STATIC_DIR = Path(__file__).parent / "static"

# Serve static files
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# Temp session storage: session_id -> path to uploaded PDF
_SESSIONS: dict[str, Path] = {}
# Original filenames: session_id -> stem (no .pdf)
_FILENAMES: dict[str, str] = {}
# Thumbnail cache: session_id -> {page_num -> png_bytes}
_THUMB_CACHE: dict[str, dict[int, bytes]] = {}
# Number of thumbnails rendered so far per session
_THUMB_STATUS: dict[str, int] = {}

# Thread pool for CPU-bound PyMuPDF work
_EXECUTOR = ThreadPoolExecutor(max_workers=2)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


class CropRect(BaseModel):
    """Normalised crop rectangle (0-1 relative to page size)."""
    x: float
    y: float
    width: float
    height: float


class SlideSpec(BaseModel):
    """One output page: which source page to use, and an optional crop."""
    original_page: int          # 1-based index into the uploaded PDF
    crop: CropRect | None = None


class ProcessRequest(BaseModel):
    session_id: str
    # Ordered list of slides to include in the output PDF.
    # Duplicates are allowed (same original_page appearing more than once).
    slides: list[SlideSpec]


# ---------------------------------------------------------------------------
# Thumbnail helpers
# ---------------------------------------------------------------------------


def _render_thumbnail_sync(path: Path, page_num: int) -> bytes:
    """Render one page at thumbnail resolution (synchronous, runs in thread pool)."""
    doc = fitz.open(str(path))
    try:
        page = doc[page_num - 1]
        mat = fitz.Matrix(36 / 72, 36 / 72)  # ~0.5x scale, 36 DPI
        pix = page.get_pixmap(matrix=mat, alpha=False)
        return pix.tobytes("png")
    finally:
        doc.close()


async def _pregenerate_thumbnails(
    session_id: str, path: Path, page_count: int
) -> None:
    """Background task: render all thumbnails and cache them."""
    _THUMB_CACHE[session_id] = {}
    _THUMB_STATUS[session_id] = 0
    loop = asyncio.get_event_loop()
    for p in range(1, page_count + 1):
        try:
            png = await loop.run_in_executor(
                _EXECUTOR, _render_thumbnail_sync, path, p
            )
            _THUMB_CACHE[session_id][p] = png
        except Exception:
            pass  # skip bad pages
        _THUMB_STATUS[session_id] = p


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)) -> dict[str, Any]:
    """Accept a PDF file, store it in a temp location, return session info."""
    data = await file.read()

    # Validate it's actually a PDF
    try:
        doc = fitz.open(stream=data, filetype="pdf")
        page_count = len(doc)
        doc.close()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid PDF: {exc}") from exc

    session_id = str(uuid.uuid4())
    tmp_path = Path(tempfile.gettempdir()) / f"pdf_cropper_{session_id}.pdf"
    tmp_path.write_bytes(data)
    _SESSIONS[session_id] = tmp_path

    # Store sanitised filename stem for use in the download
    raw_name = file.filename or "document"
    _FILENAMES[session_id] = Path(raw_name).stem

    # Kick off thumbnail pre-generation in the background
    asyncio.create_task(_pregenerate_thumbnails(session_id, tmp_path, page_count))

    return {
        "session_id": session_id,
        "page_count": page_count,
        "filename_stem": _FILENAMES[session_id],
    }


@app.get("/api/page/{session_id}/{page_num}")
async def get_page(session_id: str, page_num: int) -> Response:
    """Render a PDF page as PNG at full resolution and return it."""
    path = _get_session(session_id)

    loop = asyncio.get_event_loop()
    try:
        png_bytes = await loop.run_in_executor(
            _EXECUTOR, _render_page_sync, path, page_num, 150
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return Response(content=png_bytes, media_type="image/png")


@app.get("/api/thumbnail/{session_id}/{page_num}")
async def get_thumbnail(session_id: str, page_num: int) -> Response:
    """Return a cached thumbnail, or render on demand if not ready yet."""
    _get_session(session_id)  # validates session
    session_cache = _THUMB_CACHE.get(session_id, {})
    png_bytes = session_cache.get(page_num)
    if png_bytes is None:
        # Not cached yet — render on demand at thumb resolution
        path = _get_session(session_id)
        loop = asyncio.get_event_loop()
        try:
            png_bytes = await loop.run_in_executor(
                _EXECUTOR, _render_thumbnail_sync, path, page_num
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
    return Response(
        content=png_bytes,
        media_type="image/png",
        headers={"Cache-Control": "max-age=3600"},
    )


@app.get("/api/thumbnail_status/{session_id}")
async def thumbnail_status(session_id: str) -> dict[str, int]:
    """Return how many thumbnails have been generated so far."""
    _get_session(session_id)
    ready = _THUMB_STATUS.get(session_id, 0)
    return {"ready": ready}


@app.post("/api/process")
async def process_pdf(req: ProcessRequest) -> StreamingResponse:
    """Apply crop boxes to the specified slides and return a new PDF."""
    path = _get_session(req.session_id)

    src_doc = fitz.open(str(path))
    out_doc = fitz.open()

    try:
        for slide in req.slides:
            i = slide.original_page - 1  # 0-based
            if i < 0 or i >= len(src_doc):
                continue

            page = src_doc[i]
            media_box = page.mediabox  # fitz.Rect

            if slide.crop is not None:
                crop = slide.crop
                w = media_box.width
                h = media_box.height

                x0 = media_box.x0 + crop.x * w
                y0 = media_box.y0 + crop.y * h
                x1 = x0 + crop.width * w
                y1 = y0 + crop.height * h

                # Clamp to page bounds
                x0 = max(media_box.x0, min(x0, media_box.x1))
                y0 = max(media_box.y0, min(y0, media_box.y1))
                x1 = max(media_box.x0, min(x1, media_box.x1))
                y1 = max(media_box.y0, min(y1, media_box.y1))

                crop_rect = fitz.Rect(x0, y0, x1, y1)
            else:
                crop_rect = media_box

            out_doc.insert_pdf(src_doc, from_page=i, to_page=i)
            out_page = out_doc[-1]
            out_page.set_cropbox(crop_rect)

        pdf_bytes = out_doc.tobytes(garbage=4, deflate=True)
    finally:
        src_doc.close()
        out_doc.close()

    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition":
                f'attachment; filename="{_FILENAMES.get(req.session_id, "document")}_cropped.pdf"'
        },
    )


# ---------------------------------------------------------------------------
# Shared render helper
# ---------------------------------------------------------------------------


def _render_page_sync(path: Path, page_num: int, dpi: int) -> bytes:
    """Render page at given DPI (synchronous, for thread pool)."""
    doc = fitz.open(str(path))
    try:
        if page_num < 1 or page_num > len(doc):
            raise ValueError(f"Page {page_num} not found")
        page = doc[page_num - 1]
        mat = fitz.Matrix(dpi / 72, dpi / 72)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        return pix.tobytes("png")
    finally:
        doc.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_session(session_id: str) -> Path:
    path = _SESSIONS.get(session_id)
    if path is None or not path.exists():
        raise HTTPException(status_code=404, detail="Session not found")
    return path


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
