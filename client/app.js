const MAX_BYTES = 25 * 1024 * 1024;

const form = document.getElementById("uploadForm");
const videoInput = document.getElementById("videoInput");
const promptInput = document.getElementById("promptInput");
const statusEl = document.getElementById("status");
const submitBtn = document.getElementById("submitBtn");

const listEl = document.getElementById("list");
const refreshBtn = document.getElementById("refreshBtn");

// in-memory cache of screenshot urls by submission id
const screenshotCache = new Map();

// in-memory cache of spliced outputs by submission id
const spliceCache = new Map();

function setStatus(msg, type = "info") {
  statusEl.textContent = msg;
  statusEl.dataset.type = type;
}

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function msToStamp(ms) {
  const totalMs = Math.max(0, Number(ms) || 0);
  const totalSec = Math.floor(totalMs / 1000);
  const msec = totalMs % 1000;

  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;

  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(n).padStart(3, "0");

  if (hh > 0) return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(msec)}`;
  return `${pad2(mm)}:${pad2(ss)}.${pad3(msec)}`;
}

/**
 * Partner behavior: accept either "mm:ss" or seconds (e.g. "12.5")
 * Returns ms (integer) or null.
 */
function parseTimestampToMs(input) {
  const s = String(input || "").trim();
  if (!s) return null;

  // mm:ss
  if (/^\d+:\d{2}$/.test(s)) {
    const [m, sec] = s.split(":").map(Number);
    if (!Number.isFinite(m) || !Number.isFinite(sec)) return null;
    return Math.floor((m * 60 + sec) * 1000);
  }

  // plain seconds
  const n = Number(s);
  if (Number.isFinite(n)) return Math.floor(n * 1000);

  return null;
}

function clampInt(n, min, max) {
  const v = Number.parseInt(String(n), 10);
  if (!Number.isFinite(v)) return null;
  return Math.max(min, Math.min(max, v));
}

videoInput.addEventListener("change", () => {
  setStatus("");
  const file = videoInput.files?.[0];
  if (!file) return;

  if (file.size >= MAX_BYTES) {
    setStatus(`File is ${formatBytes(file.size)} — must be under 25 MB.`, "error");
    videoInput.value = "";
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("");

  const file = videoInput.files?.[0];
  const prompt = promptInput.value.trim();

  if (!file) return setStatus("Please choose a video file.", "error");
  if (!prompt) return setStatus("Please enter a prompt.", "error");
  if (file.size >= MAX_BYTES) return setStatus("File must be under 25 MB.", "error");

  const fd = new FormData();
  fd.append("video", file);
  fd.append("prompt", prompt);

  submitBtn.disabled = true;
  setStatus("Uploading...", "info");

  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error || "Upload failed.");

    setStatus("Upload successful.", "success");
    form.reset();
    await loadSubmissions();
  } catch (err) {
    setStatus(err.message || "Upload failed.", "error");
  } finally {
    submitBtn.disabled = false;
  }
});

async function transcribe(submissionId, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Transcribing...";

  try {
    const res = await fetch(`/api/transcribe/${encodeURIComponent(submissionId)}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error || "Transcription failed.");
    await loadSubmissions();
  } catch (e) {
    alert(e.message || "Transcription failed.");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function analyzeGemini(submissionId, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Analyzing...";

  try {
    const res = await fetch(`/api/gemini/analyze/${encodeURIComponent(submissionId)}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error || "Gemini analyze failed.");
    await loadSubmissions();
  } catch (e) {
    alert(e.message || "Gemini analyze failed.");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function generateVeo(submissionId, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Generating VEO...";

  try {
    const res = await fetch(`/api/veo/generate/${encodeURIComponent(submissionId)}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error || "VEO generation failed.");
    await loadSubmissions();
  } catch (e) {
    alert(e.message || "VEO generation failed.");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function midScreenshot(submissionId, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Capturing...";

  try {
    const res = await fetch(`/api/screenshot/${encodeURIComponent(submissionId)}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error || "Screenshot failed.");

    // Bust cache so the browser doesn't reuse an older image with same name
    const url = `${data.screenshotUrl}?t=${Date.now()}`;
    screenshotCache.set(submissionId, { url, midSec: data.midSec });

    await loadSubmissions();
  } catch (e) {
    alert(e.message || "Screenshot failed.");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ---------- Splice ----------
function inferSpliceTimestampMsFromGemini(gemini) {
  const lb = gemini?.parsed?.longestBreak;
  if (!lb || typeof lb.breakStartMs !== "number" || typeof lb.breakEndMs !== "number") return null;
  return Math.round((lb.breakStartMs + lb.breakEndMs) / 2);
}

async function spliceAtTimestampMs(submissionId, timestampMs, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Splicing...";

  try {
    const fd = new FormData();
    fd.append("submissionId", submissionId);
    fd.append("timestamp", String(timestampMs));

    const res = await fetch("/api/splice", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error || "Splice failed.");

    // merged server provides outputUrl; partner server provides outputFileName
    let url = data.outputUrl;
    if (!url && data.outputFileName) url = `/eavs/${data.outputFileName}`;

    spliceCache.set(submissionId, {
      url: url ? `${url}?t=${Date.now()}` : null,
      timestampMs,
      outputFileName: data.outputFileName || null,
      outputRaw: data.output || null
    });

    await loadSubmissions();
  } catch (e) {
    alert(e.message || "Splice failed.");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/**
 * Partner UX: prompt user for "seconds or mm:ss", then splice.
 */
async function splicePromptFlow(submissionId, btn) {
  const input = prompt("Insert timestamp to splice at (seconds or mm:ss):", "00:10");
  if (!input) return;

  const ms = parseTimestampToMs(input);
  if (ms == null) return alert('Invalid timestamp format. Use seconds (e.g. "12.5") or mm:ss (e.g. "00:10").');

  return spliceAtTimestampMs(submissionId, ms, btn);
}

// ---------- Render helpers ----------
function renderSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return `<div class="muted">No timestamps found.</div>`;
  }

  return `
    <div class="segments">
      ${segments
        .slice(0, 25)
        .map((s) => {
          const start = msToStamp(s.startMs);
          const end = msToStamp(s.endMs);
          const text = escapeHtml(s.text || "");
          return `<div class="seg"><span class="time">[${start} – ${end}]</span><span class="segText">${text}</span></div>`;
        })
        .join("")}
      ${segments.length > 25 ? `<div class="muted">(${segments.length - 25} more segments hidden)</div>` : ""}
    </div>
  `;
}

function renderGemini(gemini) {
  if (!gemini?.parsed) return `<div class="muted">No Gemini analysis yet.</div>`;
  const p = gemini.parsed;
  const show = escapeHtml(p.show || "Unknown");
  const lb = p.longestBreak || {};
  const breakLine =
    typeof lb.breakStartMs === "number"
      ? `[${msToStamp(lb.breakStartMs)} – ${msToStamp(lb.breakEndMs)}] (${Math.round((lb.breakDurationMs || 0) / 100) / 10}s)`
      : "—";

  return `
    <div class="geminiSummary">
      <div><span class="muted">Show:</span> <strong>${show}</strong></div>
      <div><span class="muted">Longest break:</span> ${escapeHtml(breakLine)}</div>
      <div style="margin-top:8px"><span class="muted">Clip 1 (Question):</span><div>${escapeHtml(p.clip1Question || "")}</div></div>
      <div style="margin-top:8px"><span class="muted">Clip 2 (Answer):</span><div>${escapeHtml(p.clip2Answer || "")}</div></div>
    </div>
  `;
}

function renderVeo(veo) {
  if (!veo?.clip1Url || !veo?.clip2Url) return `<div class="muted">No VEO clips yet.</div>`;

  return `
    <div class="veoGrid">
      <div>
        <div class="muted">VEO Clip 1 (Question)</div>
        <video controls preload="metadata" src="${escapeHtml(veo.clip1Url)}" style="width:100%; border-radius:12px; margin-top:6px;"></video>
      </div>
      <div>
        <div class="muted">VEO Clip 2 (Answer)</div>
        <video controls preload="metadata" src="${escapeHtml(veo.clip2Url)}" style="width:100%; border-radius:12px; margin-top:6px;"></video>
      </div>
    </div>
  `;
}

function renderScreenshot(submissionId) {
  const s = screenshotCache.get(submissionId);
  if (!s?.url) return `<div class="muted">No screenshot yet.</div>`;
  const label = typeof s.midSec === "number" ? `Midpoint @ ${s.midSec.toFixed(2)}s` : "Midpoint";
  return `
    <div style="margin-top:10px">
      <div class="muted">Screenshot (${escapeHtml(label)})</div>
      <img src="${escapeHtml(s.url)}" alt="mid screenshot" style="width:100%; border-radius:12px; margin-top:6px; border:1px solid rgba(255,255,255,0.14);" />
    </div>
  `;
}

function renderSplice(submissionId) {
  const s = spliceCache.get(submissionId);
  if (!s) return `<div class="muted">No spliced output yet.</div>`;

  const ts = typeof s.timestampMs === "number" ? msToStamp(s.timestampMs) : "—";
  if (!s.url) {
    const extra = s.outputFileName
      ? `<div class="muted" style="margin-top:6px">Output file: ${escapeHtml(s.outputFileName)}</div>`
      : s.outputRaw
      ? `<div class="muted" style="margin-top:6px">Output: ${escapeHtml(String(s.outputRaw))}</div>`
      : "";
    return `<div class="muted">Splice done @ ${escapeHtml(ts)} but no playable URL was returned.${extra}</div>`;
  }

  return `
    <div style="margin-top:10px">
      <div class="muted">Spliced output @ ${escapeHtml(ts)}</div>
      <video controls preload="metadata" src="${escapeHtml(s.url)}" style="width:100%; border-radius:12px; margin-top:6px;"></video>
      <div style="margin-top:6px">
        <a class="muted" href="${escapeHtml(s.url)}" target="_blank" rel="noreferrer">Open in new tab</a>
      </div>
    </div>
  `;
}

// ---------- Load + render list ----------
async function loadSubmissions() {
  listEl.innerHTML = "Loading...";
  try {
    const res = await fetch("/api/submissions");
    const data = await res.json();
    if (!data.ok) throw new Error("Failed to load submissions.");

    const items = data.submissions ?? [];
    if (items.length === 0) {
      listEl.innerHTML = "<p class='muted'>No uploads yet.</p>";
      return;
    }

    listEl.innerHTML = items
      .slice(0, 10)
      .map((s) => {
        const size = formatBytes(s.file.sizeBytes);
        const when = new Date(s.createdAt).toLocaleString();

        const transcriptText = s.transcript?.text
          ? `<div class="transcript"><div class="muted">Transcript</div><div>${escapeHtml(s.transcript.text)}</div></div>`
          : `<div class="muted">No transcript yet.</div>`;

        const timestamps = s.transcript?.segments
          ? `<div class="transcript"><div class="muted">Timestamps (first 25)</div>${renderSegments(s.transcript.segments)}</div>`
          : "";

        const geminiBox = `
          <div class="transcript">
            <div class="muted">Gemini (2×8s scripts)</div>
            ${renderGemini(s.gemini)}
          </div>
        `;

        const veoBox = `
          <div class="transcript">
            <div class="muted">VEO Clips</div>
            ${renderVeo(s.veo)}
          </div>
        `;

        const screenshotBox = `
          <div class="transcript">
            <div class="muted">Mid Screenshot</div>
            ${renderScreenshot(s.id)}
          </div>
        `;

        const inferred = inferSpliceTimestampMsFromGemini(s.gemini);
        const inferredLabel =
          typeof inferred === "number" ? `Splice @ longest break (~${msToStamp(inferred)})` : "Splice @ longest break";

        const spliceBox = `
          <div class="transcript">
            <div class="muted">Splice</div>

            <div class="actions" style="gap:8px; flex-wrap:wrap;">
              <!-- partner behavior -->
              <button data-action="splice-prompt" data-id="${escapeHtml(s.id)}">Splice (prompt)</button>

              <!-- extra (non-breaking): splice at inferred break -->
              <button data-action="splice-auto" data-id="${escapeHtml(s.id)}" ${
          typeof inferred === "number" ? `data-ts="${String(inferred)}"` : ""
        }>${escapeHtml(inferredLabel)}</button>

              <!-- custom ms inline -->
              <input
                data-action="splice-input"
                data-id="${escapeHtml(s.id)}"
                type="number"
                min="0"
                step="1"
                placeholder="timestamp ms (e.g., 90500)"
                style="max-width:220px;"
              />
              <button data-action="splice-custom" data-id="${escapeHtml(s.id)}">Splice @ custom ms</button>
            </div>

            ${renderSplice(s.id)}
          </div>
        `;

        return `
          <div class="row">
            <div class="meta">
              <div>
                <strong>${escapeHtml(s.file.originalName)}</strong>
                <span class="pill">${size}</span>
              </div>
              <div class="muted">${when}</div>
            </div>

            <div class="prompt"><div class="muted">Prompt</div>${escapeHtml(s.prompt)}</div>

            <div class="actions">
              <button data-action="transcribe" data-id="${escapeHtml(s.id)}">Transcribe</button>
              <button data-action="gemini" data-id="${escapeHtml(s.id)}">Analyze with Gemini</button>
              <button data-action="veo" data-id="${escapeHtml(s.id)}">Generate VEO Clips</button>
              <button data-action="shot" data-id="${escapeHtml(s.id)}">Mid Screenshot</button>
            </div>

            ${transcriptText}
            ${timestamps}
            ${geminiBox}
            ${veoBox}
            ${screenshotBox}
            ${spliceBox}
          </div>
        `;
      })
      .join("");

    // wire buttons
    document.querySelectorAll('button[data-action="transcribe"]').forEach((btn) => {
      btn.addEventListener("click", () => transcribe(btn.dataset.id, btn));
    });
    document.querySelectorAll('button[data-action="gemini"]').forEach((btn) => {
      btn.addEventListener("click", () => analyzeGemini(btn.dataset.id, btn));
    });
    document.querySelectorAll('button[data-action="veo"]').forEach((btn) => {
      btn.addEventListener("click", () => generateVeo(btn.dataset.id, btn));
    });
    document.querySelectorAll('button[data-action="shot"]').forEach((btn) => {
      btn.addEventListener("click", () => midScreenshot(btn.dataset.id, btn));
    });

    // splice: partner prompt flow
    document.querySelectorAll('button[data-action="splice-prompt"]').forEach((btn) => {
      btn.addEventListener("click", () => splicePromptFlow(btn.dataset.id, btn));
    });

    // splice: auto (gemini inferred)
    document.querySelectorAll('button[data-action="splice-auto"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const ts = clampInt(btn.dataset.ts, 0, Number.MAX_SAFE_INTEGER);
        if (ts == null) return alert("No longest-break timestamp yet. Run Gemini analysis first.");
        spliceAtTimestampMs(id, ts, btn);
      });
    });

    // splice: custom ms input
    document.querySelectorAll('button[data-action="splice-custom"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const input = document.querySelector(
          `input[data-action="splice-input"][data-id="${CSS.escape(id)}"]`
        );
        const ts = clampInt(input?.value, 0, Number.MAX_SAFE_INTEGER);
        if (ts == null) return alert("Enter a valid timestamp in milliseconds.");
        spliceAtTimestampMs(id, ts, btn);
      });
    });
  } catch (e) {
    listEl.innerHTML = `<p class="error">Error: ${escapeHtml(e.message)}</p>`;
  }
}

refreshBtn.addEventListener("click", loadSubmissions);
loadSubmissions();