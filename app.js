(() => {
'use strict';

// ═══════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════
const API_URL = 'https://api.cerebras.ai/v1/chat/completions';
const MODEL = 'gemma-4-31b';
const DEFAULT_KEY = 'csk-tkycdycedvycx4vxrxe2jxd9w4994h3jnpt36jcf3y3242md';
const MAX_CAPTURE_DIM = 1280;
const JPEG_QUALITY = 0.8;
const BOX_COLOR = '#00ff88';
const BOX_FILL = 'rgba(0, 255, 136, 0.08)';
const FONT = "'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', monospace";

const SCHEMA = {
    type: 'object',
    properties: {
        detections: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    original: { type: 'string' },
                    translation: { type: 'string' },
                    language: { type: 'string' },
                    x1: { type: 'number' },
                    y1: { type: 'number' },
                    x2: { type: 'number' },
                    y2: { type: 'number' }
                },
                required: ['original', 'translation', 'language', 'x1', 'y1', 'x2', 'y2'],
                additionalProperties: false
            }
        }
    },
    required: ['detections'],
    additionalProperties: false
};

// ═══════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════
const state = {
    apiKey: localStorage.getItem('gct_key') || DEFAULT_KEY,
    targetLang: localStorage.getItem('gct_lang') || 'English',
    scanInterval: parseInt(localStorage.getItem('gct_interval')) || 2500,
    autoScan: false,
    scanning: false,
    detections: [],
    autoTimer: null,
    cameraReady: false,
    flashEl: null,
};

// ═══════════════════════════════════════════════
// DOM
// ═══════════════════════════════════════════════
const $ = id => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const ctx = overlay.getContext('2d');

// ═══════════════════════════════════════════════
// Camera
// ═══════════════════════════════════════════════
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false
        });
        video.srcObject = stream;
        await new Promise(resolve => {
            video.onloadedmetadata = () => {
                video.play();
                resizeOverlay();
                resolve();
            };
        });
        state.cameraReady = true;
        $('start-screen').classList.add('hidden');
        toast('Camera ready — tap SCAN to translate');
    } catch (err) {
        toast('Camera access denied: ' + err.message, 4000, true);
        console.error(err);
    }
}

function resizeOverlay() {
    const rect = video.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(rect.width * dpr);
    overlay.height = Math.round(rect.height * dpr);
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (state.detections.length) drawOverlay();
}

// ═══════════════════════════════════════════════
// Frame Capture
// ═══════════════════════════════════════════════
function captureFrame() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    let w = vw, h = vh;
    if (Math.max(w, h) > MAX_CAPTURE_DIM) {
        if (w > h) { h = Math.round(h * MAX_CAPTURE_DIM / w); w = MAX_CAPTURE_DIM; }
        else { w = Math.round(w * MAX_CAPTURE_DIM / h); h = MAX_CAPTURE_DIM; }
    }

    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(video, 0, 0, w, h);
    return c.toDataURL('image/jpeg', JPEG_QUALITY);
}

// ═══════════════════════════════════════════════
// API Call
// ═══════════════════════════════════════════════
async function scan() {
    if (state.scanning || !state.cameraReady) return;
    state.scanning = true;

    const imgData = captureFrame();
    if (!imgData) { state.scanning = false; return; }

    flashScreen();
    $('scan-btn').classList.add('scanning');
    $('scan-status-text').textContent = 'SCANNING...';

    const t0 = performance.now();

    const body = {
        model: MODEL,
        messages: [{
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: `Detect all visible text in this image. For each text region, provide: the original text, the source language, the translation to ${state.targetLang}, and bounding box coordinates as percentages (0-100) of the image dimensions where (0,0) is top-left and (100,100) is bottom-right. Return only valid JSON.`
                },
                {
                    type: 'image_url',
                    image_url: { url: imgData }
                }
            ]
        }],
        max_tokens: 2048,
        temperature: 0.1,
        response_format: {
            type: 'json_schema',
            json_schema: { name: 'translation_result', strict: true, schema: SCHEMA }
        }
    };

    try {
        const resp = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + state.apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            const msg = err.error?.message || err.message || resp.statusText;
            toast('API error ' + resp.status + ': ' + msg, 4000, true);
            console.error('API error:', resp.status, err);
            state.scanning = false;
            $('scan-btn').classList.remove('scanning');
            $('scan-status-text').textContent = '';
            return;
        }

        const data = await resp.json();
        const elapsed = performance.now() - t0;

        let parsed;
        try {
            parsed = JSON.parse(data.choices[0].message.content);
        } catch (e) {
            // Fallback: try to extract JSON from text
            const m = data.choices[0].message.content.match(/\{[\s\S]*\}/);
            if (m) parsed = JSON.parse(m[0]);
            else throw e;
        }

        state.detections = parsed.detections || [];
        drawOverlay();
        updateStats(data, elapsed);

        const status = state.detections.length
            ? `${state.detections.length} text region${state.detections.length > 1 ? 's' : ''} found`
            : 'No text detected';
        $('scan-status-text').textContent = status;

    } catch (err) {
        toast('Scan failed: ' + err.message, 4000, true);
        console.error(err);
        $('scan-status-text').textContent = '';
    } finally {
        state.scanning = false;
        $('scan-btn').classList.remove('scanning');
    }
}

// ═══════════════════════════════════════════════
// Coordinate Mapping (object-fit: cover)
// ═══════════════════════════════════════════════
function mapBox(det) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const dw = video.clientWidth;
    const dh = video.clientHeight;
    if (!vw || !vh || !dw || !dh) return null;

    const scale = Math.max(dw / vw, dh / vh);
    const sw = vw * scale;
    const sh = vh * scale;
    const ox = (sw - dw) / 2;
    const oy = (sh - dh) / 2;

    const x1 = (det.x1 / 100) * vw * scale - ox;
    const y1 = (det.y1 / 100) * vh * scale - oy;
    const x2 = (det.x2 / 100) * vw * scale - ox;
    const y2 = (det.y2 / 100) * vh * scale - oy;

    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ═══════════════════════════════════════════════
// Drawing
// ═══════════════════════════════════════════════
function drawOverlay() {
    const dpr = window.devicePixelRatio || 1;
    const w = overlay.width / dpr;
    const h = overlay.height / dpr;
    ctx.clearRect(0, 0, w, h);

    for (const det of state.detections) {
        const box = mapBox(det);
        if (!box) continue;
        // Skip off-screen boxes entirely
        if (box.x + box.w < 0 || box.x > w || box.y + box.h < 0 || box.y > h) continue;
        drawDetection(box, det);
    }
}

function drawDetection(box, det) {
    const { x, y, w, h } = box;

    // Semi-transparent fill
    ctx.fillStyle = BOX_FILL;
    ctx.fillRect(x, y, w, h);

    // Corner brackets
    const bl = Math.min(Math.max(Math.min(w, h) * 0.22, 8), 28);
    ctx.strokeStyle = BOX_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';

    // Top-left
    ctx.beginPath();
    ctx.moveTo(x, y + bl);
    ctx.lineTo(x, y);
    ctx.lineTo(x + bl, y);
    ctx.stroke();
    // Top-right
    ctx.beginPath();
    ctx.moveTo(x + w - bl, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + bl);
    ctx.stroke();
    // Bottom-left
    ctx.beginPath();
    ctx.moveTo(x, y + h - bl);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.stroke();
    // Bottom-right
    ctx.beginPath();
    ctx.moveTo(x + w - bl, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w, y + h - bl);
    ctx.stroke();

    drawLabels(box, det);
}

function drawLabels(box, det) {
    const { x, y, w, h } = box;
    const pad = 5;

    // ── Top label: original text + language ──
    ctx.font = `11px ${FONT}`;
    const origText = truncate(det.original, w - pad * 2, 11);
    const origW = ctx.measureText(origText).width;
    const langText = '[' + det.language + ']';
    const langW = ctx.measureText(langText).width;
    const topW = Math.max(w, origW + langW + pad * 4);
    const topH = 20;
    const topY = Math.max(y - topH - 3, 0);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
    roundRect(x, topY, topW, topH, 3);
    ctx.fill();

    ctx.fillStyle = 'rgba(0, 255, 136, 0.7)';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(origText, x + pad, topY + topH / 2);

    ctx.fillStyle = BOX_COLOR;
    ctx.textAlign = 'right';
    ctx.fillText(langText, x + topW - pad, topY + topH / 2);

    // ── Bottom label: translation ──
    ctx.font = `bold 14px ${FONT}`;
    const transText = truncate(det.translation, w + 60, 14);
    const transW = ctx.measureText(transText).width;
    const botW = Math.max(w, transW + pad * 2);
    const botH = 24;
    const botY = y + h + 3;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
    roundRect(x, botY, botW, botH, 3);
    ctx.fill();

    // Left accent bar
    ctx.fillStyle = BOX_COLOR;
    ctx.fillRect(x, botY, 3, botH);

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(transText, x + pad + 3, botY + botH / 2);
}

function truncate(text, maxWidth, fontSize) {
    ctx.font = `${fontSize}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '...').width > maxWidth) {
        t = t.slice(0, -1);
    }
    return t + '...';
}

function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ═══════════════════════════════════════════════
// Stats
// ═══════════════════════════════════════════════
function updateStats(data, elapsedMs) {
    $('s-lat').textContent = Math.round(elapsedMs) + 'ms';

    const ti = data.time_info || {};
    const usage = data.usage || {};
    const completionTokens = usage.completion_tokens || 0;
    const completionTime = ti.completion_time || 1;

    if (completionTime > 0 && completionTokens > 0) {
        const tps = (completionTokens / completionTime).toFixed(0);
        $('s-tps').textContent = tps;
    }

    $('s-det').textContent = state.detections.length;

    const langs = [...new Set(state.detections.map(d => d.language))];
    $('s-lang').textContent = langs.length ? langs.join(', ') : '--';
}

// ═══════════════════════════════════════════════
// Flash Effect
// ═══════════════════════════════════════════════
function flashScreen() {
    if (!state.flashEl) {
        state.flashEl = document.createElement('div');
        state.flashEl.id = 'flash';
        document.body.appendChild(state.flashEl);
    }
    state.flashEl.classList.add('active');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            state.flashEl.classList.remove('active');
        });
    });
}

// ═══════════════════════════════════════════════
// Toast
// ═══════════════════════════════════════════════
let toastTimer;
function toast(msg, duration = 3000, isError = false) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ═══════════════════════════════════════════════
// Auto-scan
// ═══════════════════════════════════════════════
function toggleAuto() {
    state.autoScan = !state.autoScan;
    $('auto-btn').classList.toggle('active', state.autoScan);

    if (state.autoScan) {
        toast('Auto-scan on (' + state.scanInterval + 'ms)');
        scan();
        state.autoTimer = setInterval(() => {
            if (!state.scanning) scan();
        }, state.scanInterval);
    } else {
        toast('Auto-scan off');
        clearInterval(state.autoTimer);
        state.autoTimer = null;
    }
}

// ═══════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════
function openSettings() {
    $('key-input').value = state.apiKey;
    $('lang-select').value = state.targetLang;
    $('interval-input').value = state.scanInterval;
    $('settings-panel').classList.remove('hidden');
}

function closeSettings() {
    $('settings-panel').classList.add('hidden');
}

function saveSettings() {
    state.apiKey = $('key-input').value.trim() || DEFAULT_KEY;
    state.targetLang = $('lang-select').value;
    state.scanInterval = parseInt($('interval-input').value) || 2500;

    localStorage.setItem('gct_key', state.apiKey);
    localStorage.setItem('gct_lang', state.targetLang);
    localStorage.setItem('gct_interval', state.scanInterval);

    // Restart auto timer if running
    if (state.autoScan && state.autoTimer) {
        clearInterval(state.autoTimer);
        state.autoTimer = setInterval(() => {
            if (!state.scanning) scan();
        }, state.scanInterval);
    }

    closeSettings();
    toast('Settings saved');
}

// ═══════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════
function init() {
    $('start-btn').addEventListener('click', startCamera);
    $('scan-btn').addEventListener('click', scan);
    $('auto-btn').addEventListener('click', toggleAuto);
    $('clear-btn').addEventListener('click', () => {
        state.detections = [];
        drawOverlay();
        $('scan-status-text').textContent = '';
        $('s-det').textContent = '0';
        $('s-lang').textContent = '--';
        toast('Cleared');
    });
    $('settings-btn').addEventListener('click', openSettings);
    $('settings-save').addEventListener('click', saveSettings);
    $('settings-close').addEventListener('click', closeSettings);

    // Close settings on backdrop click
    $('settings-panel').querySelector('.settings-backdrop')
        .addEventListener('click', closeSettings);

    // Resize overlay on window resize / orientation change
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resizeOverlay, 100);
    });

    // Prevent body scroll on iOS
    document.addEventListener('touchmove', e => {
        if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
        }
    }, { passive: false });
}

init();
})();
