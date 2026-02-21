/* ── State ─────────────────────────────────────────────────────────────────── */
const state = {
    sessionId: null,
    pageCount: 0,       // pages in original PDF
    fileName: 'document', // stem (no .pdf)
    slides: [],      // [ {id, originalPage, crop} ]
    currentSlideIdx: 0,
};

// Slide helpers
function currentSlide() { return state.slides[state.currentSlideIdx] || null; }
function currentCrop() { return currentSlide()?.crop || null; }
function setCurrentCrop(crop) { const s = currentSlide(); if (s) s.crop = crop; }

let slideIdCtr = 0;
function makeSlide(originalPage, crop = null) {
    return { id: `slide-${++slideIdCtr}`, originalPage, crop };
}

/* ── Drag interaction state ────────────────────────────────────────────────── */
// dragMode: 'none' | 'draw' | 'move' | 'resize'
let dragMode = 'none';
let dragHandle = null;    // 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'
let dragStartX = 0, dragStartY = 0;
let dragStartCrop = null;   // crop snapshot at drag start
let drawStartX = 0, drawStartY = 0;

const HANDLE_HALF = 7;   // half-size of a handle hit-zone, in canvas px
const CROP_MIN_NORM = 0.02; // minimum crop size in normalised units

/* ── DOM refs ──────────────────────────────────────────────────────────────── */
const dropZone = document.getElementById('drop-zone');
const viewerPane = document.getElementById('viewer-pane');
const dropCard = document.getElementById('drop-card');
const fileInput = document.getElementById('file-input');
const pageImg = document.getElementById('page-img');
const cropCanvas = document.getElementById('crop-canvas');
const ctx = cropCanvas.getContext('2d');
const thumbList = document.getElementById('thumb-list');
const thumbStatusEl = document.getElementById('thumb-status');
const thumbProgressBar = document.getElementById('thumb-progress-bar');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnClear = document.getElementById('btn-clear');
const btnDuplicate = document.getElementById('btn-duplicate');
const btnDeleteSlide = document.getElementById('btn-delete-slide');
const btnProcess = document.getElementById('btn-process');
const pageIndicator = document.getElementById('page-indicator');
const statusMsg = document.getElementById('status-msg');
const cropInfoEl = document.getElementById('crop-info');
const overlay = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');
const sidebarSection = document.getElementById('sidebar-section');

/* ── Drop-zone / upload ────────────────────────────────────────────────────── */
dropCard.addEventListener('click', () => fileInput.click());

dropCard.addEventListener('dragover', e => {
    e.preventDefault();
    dropCard.classList.add('drag-over');
});
dropCard.addEventListener('dragleave', () => dropCard.classList.remove('drag-over'));
dropCard.addEventListener('drop', e => {
    e.preventDefault();
    dropCard.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
});

fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) uploadFile(fileInput.files[0]);
});

async function uploadFile(file) {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        setStatus('Please select a PDF file.', true);
        return;
    }
    showOverlay('Uploading PDF…');
    const form = new FormData();
    form.append('file', file);
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: form });
        if (!res.ok) throw new Error((await res.json()).detail || 'Upload failed');
        const data = await res.json();

        state.sessionId = data.session_id;
        state.pageCount = data.page_count;
        state.fileName = data.filename_stem || 'document';
        state.slides = Array.from({ length: data.page_count },
            (_, i) => makeSlide(i + 1));
        state.currentSlideIdx = 0;

        showViewerPane();
        renderSidebar();
        startThumbnailPolling();
        await loadCurrentSlide();
        updateToolbar();
        setStatus(`Loaded "${file.name}" — ${data.page_count} page${data.page_count !== 1 ? 's' : ''}`);
    } catch (err) {
        setStatus(`Error: ${err.message}`, true);
    } finally {
        hideOverlay();
    }
}

/* ── Sidebar ───────────────────────────────────────────────────────────────── */
function renderSidebar() {
    thumbList.innerHTML = '';
    state.slides.forEach((slide, idx) => {
        const item = document.createElement('div');
        item.className = 'thumb-item' + (idx === state.currentSlideIdx ? ' active' : '');
        item.dataset.idx = idx;

        const numEl = document.createElement('span');
        numEl.className = 'thumb-num';
        numEl.textContent = idx + 1;

        const img = document.createElement('img');
        img.className = 'thumb-preview loading';
        img.alt = `Page ${slide.originalPage}`;
        img.id = `thumb-img-${slide.id}`;
        // Use thumbnail endpoint; remove loading class once image loads
        img.onload = () => img.classList.remove('loading');
        img.src = `/api/thumbnail/${state.sessionId}/${slide.originalPage}`;

        const badge = document.createElement('span');
        badge.className = `thumb-badge ${slide.crop ? 'cropped' : 'uncropped'}`;
        badge.id = `badge-${slide.id}`;

        item.append(numEl, img, badge);
        item.addEventListener('click', () => goToSlide(idx));
        thumbList.appendChild(item);
    });
}

function updateSidebarItem(idx) {
    const slide = state.slides[idx];
    if (!slide) return;
    const badge = document.getElementById(`badge-${slide.id}`);
    if (badge) badge.className = `thumb-badge ${slide.crop ? 'cropped' : 'uncropped'}`;

    document.querySelectorAll('.thumb-item').forEach((el, i) => {
        el.classList.toggle('active', i === state.currentSlideIdx);
        // keep numbering in sync
        el.querySelector('.thumb-num').textContent = i + 1;
    });

    // Scroll the sidebar list to show the active item — without touching page scroll
    const activeEl = thumbList.children[state.currentSlideIdx];
    if (activeEl) {
        const elTop = activeEl.offsetTop - thumbList.scrollTop;
        const elBottom = elTop + activeEl.offsetHeight;
        const listH = thumbList.clientHeight;
        if (elTop < 0 || elBottom > listH) {
            thumbList.scrollTop = activeEl.offsetTop - listH / 2 + activeEl.offsetHeight / 2;
        }
    }
}

/* ── Navigation ────────────────────────────────────────────────────────────── */
async function goToSlide(idx) {
    if (idx < 0 || idx >= state.slides.length) return;
    state.currentSlideIdx = idx;
    await loadCurrentSlide();
    updateToolbar();
    updateSidebarItem(idx);
}

async function loadCurrentSlide() {
    const slide = currentSlide();
    if (!slide) return;
    pageImg.src = '';
    await new Promise(resolve => {
        const url = `/api/page/${state.sessionId}/${slide.originalPage}?_=${Date.now()}`;
        pageImg.onload = resolve;
        pageImg.onerror = resolve;
        pageImg.src = url;
    });
    syncCanvasSize();
    drawCrop();
    setStatus(`Slide ${state.currentSlideIdx + 1} of ${state.slides.length}  (source page ${slide.originalPage})`);
}

function syncCanvasSize() {
    cropCanvas.width = pageImg.naturalWidth || pageImg.clientWidth || 1;
    cropCanvas.height = pageImg.naturalHeight || pageImg.clientHeight || 1;
    cropCanvas.style.width = pageImg.clientWidth + 'px';
    cropCanvas.style.height = pageImg.clientHeight + 'px';
}

/* ── Toolbar ───────────────────────────────────────────────────────────────── */
function updateToolbar() {
    const n = state.slides.length;
    const idx = state.currentSlideIdx;
    btnPrev.disabled = idx <= 0;
    btnNext.disabled = idx >= n - 1;
    btnDuplicate.disabled = !state.sessionId;
    btnDeleteSlide.disabled = n <= 1;
    pageIndicator.textContent = `${idx + 1} / ${n}`;

    const crop = currentCrop();
    btnClear.disabled = !crop;
    if (crop) {
        const pct = v => (v * 100).toFixed(0);
        cropInfoEl.textContent =
            `${pct(crop.x)}%, ${pct(crop.y)}%  →  ${pct(crop.x + crop.width)}%, ${pct(crop.y + crop.height)}%`;
        cropInfoEl.style.display = 'inline-flex';
    } else {
        cropInfoEl.style.display = 'none';
    }

    const croppedCount = state.slides.filter(s => s.crop).length;
    btnProcess.disabled = !state.sessionId;
    btnProcess.textContent = croppedCount === 0
        ? '⬇ Download (no crops)'
        : `⬇ Download (${croppedCount} cropped)`;
}

btnPrev.addEventListener('click', () => goToSlide(state.currentSlideIdx - 1));
btnNext.addEventListener('click', () => goToSlide(state.currentSlideIdx + 1));

btnClear.addEventListener('click', () => {
    setCurrentCrop(null);
    drawCrop();
    updateToolbar();
    updateSidebarItem(state.currentSlideIdx);
    setStatus('Crop cleared for this slide.');
});

btnDuplicate.addEventListener('click', () => {
    const slide = currentSlide();
    if (!slide) return;
    // Deep-copy crop if present
    const newSlide = makeSlide(slide.originalPage, slide.crop ? { ...slide.crop } : null);
    state.slides.splice(state.currentSlideIdx + 1, 0, newSlide);
    renderSidebar();
    goToSlide(state.currentSlideIdx + 1);
    setStatus(`Duplicated slide (source page ${slide.originalPage})`);
});

btnDeleteSlide.addEventListener('click', () => {
    if (state.slides.length <= 1) return;
    state.slides.splice(state.currentSlideIdx, 1);
    const newIdx = Math.min(state.currentSlideIdx, state.slides.length - 1);
    state.currentSlideIdx = newIdx;
    renderSidebar();
    goToSlide(newIdx);
    setStatus('Slide deleted.');
});

/* ── Handle geometry ───────────────────────────────────────────────────────── */
function getHandles(crop) {
    const W = cropCanvas.width, H = cropCanvas.height;
    const x0 = crop.x * W, y0 = crop.y * H;
    const x1 = (crop.x + crop.width) * W, y1 = (crop.y + crop.height) * H;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    return [
        { name: 'nw', cx: x0, cy: y0 },
        { name: 'n', cx: mx, cy: y0 },
        { name: 'ne', cx: x1, cy: y0 },
        { name: 'e', cx: x1, cy: my },
        { name: 'se', cx: x1, cy: y1 },
        { name: 's', cx: mx, cy: y1 },
        { name: 'sw', cx: x0, cy: y1 },
        { name: 'w', cx: x0, cy: my },
    ];
}

function hitTestHandle(x, y, crop) {
    for (const h of getHandles(crop)) {
        if (Math.abs(x - h.cx) <= HANDLE_HALF && Math.abs(y - h.cy) <= HANDLE_HALF) {
            return h.name;
        }
    }
    return null;
}

function isInsideCrop(x, y, crop) {
    const W = cropCanvas.width, H = cropCanvas.height;
    return x >= crop.x * W && x <= (crop.x + crop.width) * W
        && y >= crop.y * H && y <= (crop.y + crop.height) * H;
}

const CURSOR_MAP = {
    nw: 'nw-resize', n: 'n-resize', ne: 'ne-resize',
    e: 'e-resize', se: 'se-resize', s: 's-resize',
    sw: 'sw-resize', w: 'w-resize',
    move: 'move',
    draw: 'crosshair',
};

function getCursorForPos(x, y, crop) {
    if (!crop) return 'crosshair';
    const handle = hitTestHandle(x, y, crop);
    if (handle) return CURSOR_MAP[handle];
    if (isInsideCrop(x, y, crop)) return 'move';
    return 'crosshair';
}

/* ── Crop math helpers ─────────────────────────────────────────────────────── */
function applyHandleDrag(startCrop, handle, dxNorm, dyNorm) {
    let x0 = startCrop.x;
    let y0 = startCrop.y;
    let x1 = x0 + startCrop.width;
    let y1 = y0 + startCrop.height;

    if (handle.includes('w')) x0 = Math.min(x0 + dxNorm, x1 - CROP_MIN_NORM);
    if (handle.includes('e')) x1 = Math.max(x1 + dxNorm, x0 + CROP_MIN_NORM);
    if (handle.includes('n')) y0 = Math.min(y0 + dyNorm, y1 - CROP_MIN_NORM);
    if (handle.includes('s')) y1 = Math.max(y1 + dyNorm, y0 + CROP_MIN_NORM);

    x0 = Math.max(0, Math.min(x0, 1 - CROP_MIN_NORM));
    y0 = Math.max(0, Math.min(y0, 1 - CROP_MIN_NORM));
    x1 = Math.max(CROP_MIN_NORM, Math.min(x1, 1));
    y1 = Math.max(CROP_MIN_NORM, Math.min(y1, 1));

    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function applyMoveDrag(startCrop, dxNorm, dyNorm) {
    const x = Math.max(0, Math.min(startCrop.x + dxNorm, 1 - startCrop.width));
    const y = Math.max(0, Math.min(startCrop.y + dyNorm, 1 - startCrop.height));
    return { ...startCrop, x, y };
}

/* ── Canvas interaction ────────────────────────────────────────────────────── */
function canvasCoords(e) {
    const rect = cropCanvas.getBoundingClientRect();
    const scaleX = cropCanvas.width / rect.width;
    const scaleY = cropCanvas.height / rect.height;
    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
        norm: (cx, cy) => ({ x: cx / cropCanvas.width, y: cy / cropCanvas.height }),
    };
}

cropCanvas.addEventListener('mousedown', onPointerDown);
cropCanvas.addEventListener('mousemove', onPointerMove);
cropCanvas.addEventListener('mouseup', onPointerUp);
cropCanvas.addEventListener('mouseleave', () => {
    if (dragMode !== 'none') onPointerUp();
});

// Touch
cropCanvas.addEventListener('touchstart', e => { e.preventDefault(); onPointerDown(e.touches[0]); }, { passive: false });
cropCanvas.addEventListener('touchmove', e => { e.preventDefault(); onPointerMove(e.touches[0]); }, { passive: false });
cropCanvas.addEventListener('touchend', e => { e.preventDefault(); onPointerUp(); });

function onPointerDown(e) {
    const { x, y } = canvasCoords(e);
    const crop = currentCrop();

    if (crop) {
        const handle = hitTestHandle(x, y, crop);
        if (handle) {
            dragMode = 'resize';
            dragHandle = handle;
            dragStartX = x;
            dragStartY = y;
            dragStartCrop = { ...crop };
            return;
        }
        if (isInsideCrop(x, y, crop)) {
            dragMode = 'move';
            dragStartX = x;
            dragStartY = y;
            dragStartCrop = { ...crop };
            return;
        }
    }

    // Start new draw
    dragMode = 'draw';
    drawStartX = x;
    drawStartY = y;
}

function onPointerMove(e) {
    const { x, y } = canvasCoords(e);

    if (dragMode === 'none') {
        // Hover: update cursor
        cropCanvas.style.cursor = getCursorForPos(x, y, currentCrop());
        return;
    }

    const W = cropCanvas.width, H = cropCanvas.height;

    if (dragMode === 'draw') {
        ctx.clearRect(0, 0, W, H);
        drawSavedCrop(0.2);
        const rx = Math.min(drawStartX, x), ry = Math.min(drawStartY, y);
        const rw = Math.abs(x - drawStartX), rh = Math.abs(y - drawStartY);
        drawSelectionRect(rx, ry, rw, rh, true);
        return;
    }

    const dxNorm = (x - dragStartX) / W;
    const dyNorm = (y - dragStartY) / H;

    let newCrop;
    if (dragMode === 'resize') {
        newCrop = applyHandleDrag(dragStartCrop, dragHandle, dxNorm, dyNorm);
    } else {
        newCrop = applyMoveDrag(dragStartCrop, dxNorm, dyNorm);
    }
    setCurrentCrop(newCrop);
    drawCrop();
}

function onPointerUp(e) {
    if (dragMode === 'none') return;

    if (dragMode === 'draw' && e) {
        const { x, y } = canvasCoords(e);
        const rx = Math.min(drawStartX, x), ry = Math.min(drawStartY, y);
        const rw = Math.abs(x - drawStartX), rh = Math.abs(y - drawStartY);
        const W = cropCanvas.width, H = cropCanvas.height;
        if (rw > 5 && rh > 5) {
            setCurrentCrop({
                x: rx / W, y: ry / H,
                width: rw / W, height: rh / H,
            });
        }
    }

    dragMode = 'none';
    dragHandle = null;
    drawCrop();
    updateToolbar();
    updateSidebarItem(state.currentSlideIdx);
    cropCanvas.style.cursor = getCursorForPos(0, 0, currentCrop()) || 'crosshair';
}

/* ── Drawing ───────────────────────────────────────────────────────────────── */
function drawCrop() {
    ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
    drawSavedCrop(1);
}

function drawSavedCrop(alpha) {
    const crop = currentCrop();
    if (!crop) return;
    const W = cropCanvas.width, H = cropCanvas.height;
    const rx = crop.x * W, ry = crop.y * H;
    const rw = crop.width * W, rh = crop.height * H;
    drawSelectionRect(rx, ry, rw, rh, false, alpha);
}

function drawSelectionRect(rx, ry, rw, rh, live = false, alpha = 1) {
    if (rw <= 0 || rh <= 0) return;
    const W = cropCanvas.width, H = cropCanvas.height;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Dim outside selection
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(0, 0, W, ry);
    ctx.fillRect(0, ry + rh, W, H - ry - rh);
    ctx.fillRect(0, ry, rx, rh);
    ctx.fillRect(rx + rw, ry, W - rx - rw, rh);

    // Border
    ctx.strokeStyle = live ? '#aabbff' : '#6c8cff';
    ctx.lineWidth = live ? 1.5 : 2;
    ctx.setLineDash(live ? [5, 3] : []);
    ctx.shadowColor = '#6c8cff';
    ctx.shadowBlur = live ? 4 : 8;
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.setLineDash([]);

    // Draw handles (only for confirmed crop, not during live draw)
    if (!live) {
        const hSize = HANDLE_HALF * 1.15; // slightly bigger than hit zone for visual
        const handles = getHandles({ x: rx / W, y: ry / H, width: rw / W, height: rh / H });
        handles.forEach(({ cx, cy, name }) => {
            const isCorner = name.length === 2;
            // Filled square handle
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = '#6c8cff';
            ctx.shadowBlur = 10;
            const s = isCorner ? hSize : hSize * 0.78;
            ctx.fillRect(cx - s, cy - s, s * 2, s * 2);
            // Inner accent colour
            ctx.fillStyle = '#6c8cff';
            ctx.shadowBlur = 0;
            const inner = s * 0.45;
            ctx.fillRect(cx - inner, cy - inner, inner * 2, inner * 2);
        });
    }

    ctx.restore();
}

/* ── Process & Download ────────────────────────────────────────────────────── */
btnProcess.addEventListener('click', async () => {
    if (!state.sessionId) return;
    showOverlay('Processing PDF…');
    try {
        const res = await fetch('/api/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: state.sessionId,
                slides: state.slides.map(s => ({
                    original_page: s.originalPage,
                    crop: s.crop || null,
                })),
            }),
        });
        if (!res.ok) throw new Error((await res.json()).detail || 'Processing failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${state.fileName}_cropped.pdf`; a.click();
        URL.revokeObjectURL(url);
        setStatus('Download started — cropped.pdf');
    } catch (err) {
        setStatus(`Error: ${err.message}`, true);
    } finally {
        hideOverlay();
    }
});

/* ── Keyboard shortcuts ────────────────────────────────────────────────────── */
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (!state.sessionId) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') goToSlide(state.currentSlideIdx - 1);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') goToSlide(state.currentSlideIdx + 1);
    if (e.key === 'Delete' || e.key === 'Backspace') btnClear.click();
});

/* ── Thumbnail polling ─────────────────────────────────────────────────────── */
let _thumbPollTimer = null;

function startThumbnailPolling() {
    clearInterval(_thumbPollTimer);
    thumbProgressBar.style.width = '0%';
    thumbStatusEl.textContent = `0 / ${state.pageCount}`;

    _thumbPollTimer = setInterval(async () => {
        try {
            const res = await fetch(`/api/thumbnail_status/${state.sessionId}`);
            const data = await res.json();
            const ready = data.ready ?? 0;
            const total = state.pageCount;
            const pct = total > 0 ? (ready / total) * 100 : 0;

            thumbProgressBar.style.width = pct + '%';
            thumbStatusEl.textContent = ready < total ? `${ready} / ${total}` : '';

            if (ready >= total) {
                clearInterval(_thumbPollTimer);
                thumbProgressBar.style.width = '0%';
            }
        } catch { /* ignore transient errors */ }
    }, 400);
}

/* ── Resize ────────────────────────────────────────────────────────────────── */
window.addEventListener('resize', () => { if (state.sessionId) { syncCanvasSize(); drawCrop(); } });

/* ── Helpers ───────────────────────────────────────────────────────────────── */
function showViewerPane() {
    dropZone.style.display = 'none';
    viewerPane.style.display = 'flex';
    sidebarSection.style.display = 'flex';
}

function setStatus(msg, isError = false) {
    statusMsg.textContent = msg;
    statusMsg.style.color = isError ? 'var(--danger)' : '';
}

function showOverlay(msg) { overlayMsg.textContent = msg; overlay.classList.add('show'); }
function hideOverlay() { overlay.classList.remove('show'); }
