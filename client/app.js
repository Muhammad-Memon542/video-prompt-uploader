const MAX_BYTES = 25 * 1024 * 1024;

const form = document.getElementById("uploadForm");
const videoInput = document.getElementById("videoInput");
const promptInput = document.getElementById("promptInput");
const statusEl = document.getElementById("status");
const submitBtn = document.getElementById("submitBtn");

const listEl = document.getElementById("list");
const refreshBtn = document.getElementById("refreshBtn");

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
    btn.textContent = "Transcribe";
  }
}

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
        const transcriptHtml = s.transcript?.text
          ? `<div class="transcript"><div class="muted">Transcript</div><div>${escapeHtml(s.transcript.text)}</div></div>`
          : `<div class="muted">No transcript yet.</div>`;

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
            </div>

            ${transcriptHtml}
          </div>
        `;
      })
      .join("");

    // wire buttons
    document.querySelectorAll('button[data-action="transcribe"]').forEach((btn) => {
      btn.addEventListener("click", () => transcribe(btn.dataset.id, btn));
    });
  } catch (e) {
    listEl.innerHTML = `<p class="error">Error: ${escapeHtml(e.message)}</p>`;
  }
}

refreshBtn.addEventListener("click", loadSubmissions);
loadSubmissions();
