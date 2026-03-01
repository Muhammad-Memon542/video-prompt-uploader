const MAX_BYTES = 25 * 1024 * 1024;

const form = document.getElementById("uploadForm");
const videoInput = document.getElementById("videoInput");
const urlInput = document.getElementById("urlInput");
const promptInput = document.getElementById("promptInput");
const submitBtn = document.getElementById("submitBtn");
const resetBtn = document.getElementById("resetBtn");

const statusEl = document.getElementById("status");
const progressWrap = document.getElementById("progressWrap");
const progressFill = document.getElementById("progressFill");
const progressPct = document.getElementById("progressPct");
const progressStep = document.getElementById("progressStep");
const progressBar = progressWrap?.querySelector(".progress-bar");

const scrollToCreateBtn = document.getElementById("scrollToCreate");
const tabCreate = document.getElementById("tabCreate");
const tabExplore = document.getElementById("tabExplore");

const resultSection = document.getElementById("result");
const resultVideo = document.getElementById("resultVideo");
const resultMeta = document.getElementById("resultMeta");
const downloadLink = document.getElementById("downloadLink");
const newOneBtn = document.getElementById("newOne");
const rail = document.getElementById("rail");

// ---------- Debug / Pipeline panel (remove anytime) ----------
const debugToggle = document.getElementById("debugToggle");
const debugPanel = document.getElementById("debugPanel");
const debugClose = document.getElementById("debugClose");
const debugSteps = document.getElementById("debugSteps");
const debugLogEl = document.getElementById("debugLog");

const DEBUG_ENABLED = true; // flip to false to effectively disable UI without deleting code

function debugSetOpen(open){
  if (!DEBUG_ENABLED) return;
  if (!debugPanel || !debugToggle) return;
  debugPanel.hidden = !open;
  debugToggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) debugToggle.style.display = "none";
  else debugToggle.style.display = "";
}

debugToggle?.addEventListener("click", () => debugSetOpen(true));
debugClose?.addEventListener("click", () => debugSetOpen(false));

function debugLog(msg){
  if (!DEBUG_ENABLED || !debugLogEl) return;
  const t = new Date();
  const hh = String(t.getHours()).padStart(2,"0");
  const mm = String(t.getMinutes()).padStart(2,"0");
  const ss = String(t.getSeconds()).padStart(2,"0");
  debugLogEl.textContent += `[${hh}:${mm}:${ss}] ${msg}\n`;
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

function debugSetStep(step, statusText, state){
  if (!DEBUG_ENABLED || !debugSteps) return;
  const items = debugSteps.querySelectorAll("li");
  items.forEach((li) => {
    const s = li.getAttribute("data-step");
    if (s === step) {
      li.classList.remove("is-active","is-done","is-error");
      if (state === "active") li.classList.add("is-active");
      if (state === "done") li.classList.add("is-done");
      if (state === "error") li.classList.add("is-error");
      const sub = li.querySelector(".s");
      if (sub && statusText) sub.textContent = statusText;
    }
  });
}

function debugReset(){
  if (!DEBUG_ENABLED || !debugSteps) return;
  debugLogEl && (debugLogEl.textContent = "");
  ["upload","transcription","analysis","screenshot","generation","splicing","done"].forEach((s) => {
    debugSetStep(s, "Waiting…", null);
  });
  debugSetOpen(false);
}

function setStatus(msg, type = "info") {
  statusEl.textContent = msg || "";
  statusEl.dataset.type = type;
}

function showProgress(show) {
  if (!progressWrap) return;
  progressWrap.hidden = !show;
}

function setProgress(pct, stepLabel, msg) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  progressFill.style.width = `${v}%`;
  progressPct.textContent = `${Math.round(v)}%`;
  progressStep.textContent = stepLabel || "Working…";
  if (progressBar) progressBar.setAttribute("aria-valuenow", String(Math.round(v)));
  if (msg) setStatus(msg, "info");
}

function formatBytes(bytes) {
  const mb = (Number(bytes) || 0) / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function fmtStamp(ms) {
  const totalMs = Math.max(0, Number(ms) || 0);
  const totalSec = Math.floor(totalMs / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function scrollToCreate() {
  document.getElementById("create")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

scrollToCreateBtn?.addEventListener("click", scrollToCreate);
tabCreate?.addEventListener("click", scrollToCreate);

tabExplore?.addEventListener("click", async () => {
  // Soft "Explore": if we have results, scroll to them; otherwise show recent list.
  if (!resultSection.hidden) {
    resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    await loadRail();
    document.getElementById("create")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

resetBtn?.addEventListener("click", () => {
  debugReset?.();
  form.reset();
  setStatus("");
  showProgress(false);
});

newOneBtn?.addEventListener("click", () => {
  debugReset?.();
  resultSection.hidden = true;
  form.reset();
  setStatus("");
  showProgress(false);
  scrollToCreate();
});

async function loadRail(highlightId = null) {
  rail.innerHTML = "";
  try {
    const res = await fetch("/api/submissions");
    const data = await res.json();
    const subs = data?.submissions || [];
    if (!subs.length) {
      rail.innerHTML = `<div class="helper">No recent items yet.</div>`;
      return;
    }

    subs.slice(0, 6).forEach((s) => {
      const tags = [
        { label: "Mathematics", cls: "red" },
        { label: (s?.gemini?.parsed?.show || "Show"), cls: "yellow" },
        { label: "Trending", cls: "green" },
        { label: "Elementary", cls: "" }
      ];

      const item = document.createElement("button");
      item.type = "button";
      item.className = "rail-item";
      item.style.border = s.id === highlightId ? "2px solid rgba(47,125,246,.45)" : "";

      const hasOutput = Boolean(s?.eav?.outputUrl);
      const title = hasOutput ? "Generated video" : "Uploaded video";

      item.innerHTML = `
        <div class="thumb">${hasOutput ? "▶" : "⬆"}</div>
        <div>
          <div class="rail-title">${title}</div>
          <div class="helper">${new Date(s.createdAt).toLocaleString()}</div>
          <div class="tags">
            ${tags.map((t) => `<span class="tag ${t.cls}">${escapeHtml(t.label)}</span>`).join("")}
          </div>
        </div>
      `;

      item.addEventListener("click", () => {
        if (hasOutput) {
          showResult(s);
          resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });

      rail.appendChild(item);
    });
  } catch {
    rail.innerHTML = `<div class="helper">Could not load recent items.</div>`;
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showResult(submission) {
  const outputUrl = submission?.eav?.outputUrl || submission?.result?.outputUrl;
  if (!outputUrl) return;

  resultSection.hidden = false;

  resultMeta.textContent = [
    submission?.gemini?.parsed?.show ? `Show: ${submission.gemini.parsed.show}` : null,
    submission?.eav?.timestampMs != null ? `Insert at: ${fmtStamp(submission.eav.timestampMs)}` : null
  ].filter(Boolean).join(" • ");

  resultVideo.src = outputUrl;
  downloadLink.href = outputUrl;
  downloadLink.setAttribute("download", submission?.eav?.outputFileName || "eav.mp4");

  // Play quiz button: when this submission has question/answer from Gemini
  const actionsWrap = resultSection.querySelector(".result-actions");
  const existingQuizBtn = actionsWrap?.querySelector(".btn-play-quiz");
  if (existingQuizBtn) existingQuizBtn.remove();
  if (actionsWrap && submission?.gemini?.parsed?.clip1Question && submission?.gemini?.parsed?.clip2Answer) {
    const quizBtn = document.createElement("button");
    quizBtn.type = "button";
    quizBtn.className = "btn ghost btn-play-quiz";
    quizBtn.textContent = "Play quiz";
    quizBtn.addEventListener("click", () => startQuizPlayback(submission.id));
    actionsWrap.appendChild(quizBtn);
  }

  loadRail(submission?.id);
}

async function pollJob(jobId, { onUpdate }) {
  let attempts = 0;

  while (attempts < 1200) { // up to ~20 minutes at 1s
    attempts += 1;

    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.error || "Job lookup failed.");

    const job = data.job;
    onUpdate?.(job);

    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(job?.error?.message || job.message || "Pipeline failed.");

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("Timed out waiting for generation.");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("");

  const file = videoInput.files?.[0] || null;
  const url = (urlInput.value || "").trim();
  const prompt = (promptInput.value || "").trim();

  if (!prompt) return setStatus("Please enter what they should learn.", "error");

  // Upload-only for now (URL ingestion is optional future work)
  if (!file) {
    if (url) return setStatus("URL ingestion is not enabled yet — please upload an mp4/webm/mov file.", "error");
    return setStatus("Please upload a video file.", "error");
  }

  if (file.size >= MAX_BYTES) return setStatus("File must be under 25 MB.", "error");

  submitBtn.disabled = true;
  debugReset();
  debugSetOpen(true);
  debugSetStep("upload", "Preparing upload…", "active");
  debugLog("User initiated generation.");
  resetBtn.disabled = true;
  showProgress(true);
  setProgress(2, "Uploading", `Uploading ${file.name} (${formatBytes(file.size)})…`);
  debugSetStep("upload", `Uploading ${file.name}…`, "active");
  debugLog(`Uploading: ${file.name} (${formatBytes(file.size)})`);

  try {
    // 1) Upload
    const fd = new FormData();
    fd.append("video", file);
    fd.append("prompt", prompt);

    const uploadRes = await fetch("/api/upload", { method: "POST", body: fd });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok || !uploadData.ok) throw new Error(uploadData?.error || "Upload failed.");

    const submission = uploadData.submission;
    setProgress(8, "Queued", "Starting generation pipeline…");
    debugSetStep("upload", "Uploaded", "done");
    debugSetStep("transcription", "Queued", "active");
    debugLog("Upload complete. Starting pipeline.");

    // 2) Start one-click pipeline
    const startRes = await fetch(`/api/pipeline/${encodeURIComponent(submission.id)}`, { method: "POST" });
    const startData = await startRes.json();
    if (!startRes.ok || !startData.ok) throw new Error(startData?.error || "Failed to start pipeline.");

    const jobId = startData.jobId;

    // 3) Poll until done
    const job = await pollJob(jobId, {
      onUpdate: (j) => {
        const labelMap = {
          queued: "Queued",
          transcription: "Transcription",
          analysis: "Gemini analysis",
          screenshot: "Screenshot",
          generation: "Video generation",
          splicing: "Splicing",
          done: "Done",
          error: "Error"
        };
        setProgress(j.progress ?? 0, labelMap[j.step] || "Working", j.message || "Working…");
        // Debug panel step updates
        const step = j.step;
        if (step === "transcription") { debugSetStep("transcription", j.message || "Transcribing…", "active"); }
        if (step === "analysis") { debugSetStep("transcription", "Done", "done"); debugSetStep("analysis", j.message || "Analyzing…", "active"); }
        if (step === "screenshot") { debugSetStep("analysis", "Done", "done"); debugSetStep("screenshot", j.message || "Capturing…", "active"); }
        if (step === "generation") { debugSetStep("screenshot", "Done", "done"); debugSetStep("generation", j.message || "Generating…", "active"); }
        if (step === "splicing") { debugSetStep("generation", "Done", "done"); debugSetStep("splicing", j.message || "Splicing…", "active"); }
        if (step === "done") { debugSetStep("splicing", "Done", "done"); debugSetStep("done", "Complete", "done"); }
        if (step === "error") { debugSetStep("done", "Failed", "error"); }
        if (j.message) debugLog(j.message);
      }
    });

    setProgress(100, "Done", "Your video is ready.");
    debugSetStep("done", "Complete", "done");
    debugLog("Pipeline complete.");
    debugSetOpen(false);
    setStatus("Done.", "success");

    // 4) Show result
    // Fetch latest submission (includes eav)
    const subRes = await fetch("/api/submissions");
    const subData = await subRes.json();
    const latest = (subData?.submissions || []).find((s) => s.id === submission.id) || submission;

    if (latest?.eav?.outputUrl) {
      showResult(latest);
      resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (job?.result?.outputUrl) {
      // fallback: show directly from job result
      showResult({ ...latest, eav: { outputUrl: job.result.outputUrl, outputFileName: job.result.outputFileName } });
      resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      setStatus("Pipeline finished but output was not found.", "error");
    }
  } catch (err) {
    console.error(err);
    setStatus(err?.message || "Generation failed.", "error");
    debugLog(`ERROR: ${err?.message || "Generation failed."}`);
    debugSetOpen(true);
    debugSetStep("done", "Failed", "error");
    showProgress(false);
  } finally {
    submitBtn.disabled = false;
    resetBtn.disabled = false;
  }
});

// Initial rail load
loadRail();

// Initialize debug panel
try { debugReset(); } catch {}

// ---------- Quiz playback: app detects wait screen and auto-starts voice (no Alexa) ----------
async function getEchoSession(submissionId) {
  const res = await fetch(`/api/echo/session/${encodeURIComponent(submissionId)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "Session failed.");
  return data;
}

async function ensureSpliceUrl(submissionId, session) {
  const ts = session?.timeline?.spliceTimestampMs;
  if (typeof ts !== "number") throw new Error("No splice timestamp in session.");
  const fd = new FormData();
  fd.append("submissionId", submissionId);
  fd.append("timestamp", String(ts));
  const res = await fetch("/api/splice", { method: "POST", body: fd });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data?.error || "Splice failed.");
  const url = data.outputUrl || (data.outputFileName ? `/eavs/${data.outputFileName}` : null);
  return url || null;
}

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

async function startQuizPlayback(submissionId) {
  try {
    const session = await getEchoSession(submissionId);
    const questionEndMs = session?.timeline?.questionEndMs;
    const answerStartMs = session?.timeline?.answerStartMs;
    if (typeof questionEndMs !== "number") throw new Error("Session missing timeline.questionEndMs.");

    const videoUrl = await ensureSpliceUrl(submissionId, session);
    if (!videoUrl) throw new Error("Could not get spliced video URL.");

    const overlay = document.createElement("div");
    overlay.className = "quizOverlay";
    const video = document.createElement("video");
    video.className = "quizVideo";
    video.controls = true;
    video.src = videoUrl;
    video.preload = "auto";

    const waitScreen = document.createElement("div");
    waitScreen.className = "quizWaitScreen";
    waitScreen.innerHTML = '<h3>What\'s your answer?</h3><p class="quizStatus" aria-live="polite"></p>';
    waitScreen.style.display = "none";

    const closeBtn = document.createElement("button");
    closeBtn.className = "quizClose";
    closeBtn.textContent = "Close";
    closeBtn.type = "button";

    overlay.appendChild(closeBtn);
    overlay.appendChild(video);
    overlay.appendChild(waitScreen);
    document.body.appendChild(overlay);

    let recognition = null;
    let answered = false;

    function showWaitScreenAndListen() {
      if (answered) return;
      answered = true;
      video.pause();
      waitScreen.style.display = "block";
      waitScreen.classList.remove("result", "error");
      const statusEl = waitScreen.querySelector(".quizStatus");

      const Recognition = getSpeechRecognition();
      if (!Recognition) {
        statusEl.textContent = "Speech recognition not supported in this browser. Use Chrome or Edge.";
        return;
      }

      recognition = new Recognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = "en-US";

      recognition.onstart = () => {
        waitScreen.classList.add("listening");
        statusEl.textContent = "Listening…";
      };
      recognition.onend = () => {
        waitScreen.classList.remove("listening");
      };
      recognition.onerror = (e) => {
        if (e.error === "no-speech") statusEl.textContent = "No speech heard. Try again.";
        else statusEl.textContent = e.error || "Recognition error.";
      };
      recognition.onresult = async (e) => {
        const transcript = (e.results[0] && e.results[0][0]) ? e.results[0][0].transcript : "";
        if (!transcript.trim()) {
          statusEl.textContent = "No answer heard. Say your answer again.";
          answered = false;
          waitScreen.classList.remove("listening");
          recognition.start();
          return;
        }
        statusEl.textContent = "Checking…";
        try {
          const res = await fetch("/api/echo/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ submissionId, userAnswer: transcript.trim() })
          });
          const data = await res.json();
          const message = data?.message || (data?.correct ? "That's right!" : "Not quite.");
          waitScreen.classList.add("result", data?.correct ? "" : "error");
          waitScreen.querySelector("h3").textContent = message;
          statusEl.textContent = "";
          const utterance = new SpeechSynthesisUtterance(message);
          utterance.rate = 0.95;
          speechSynthesis.speak(utterance);
          if (typeof answerStartMs === "number" && video.duration) {
            video.currentTime = answerStartMs / 1000;
            video.play().catch(() => {});
          }
        } catch (err) {
          waitScreen.classList.add("result", "error");
          statusEl.textContent = err.message || "Verify failed.";
        }
      };

      recognition.start();
    }

    video.addEventListener("timeupdate", () => {
      if (answered) return;
      if (video.currentTime * 1000 >= questionEndMs) showWaitScreenAndListen();
    }, { passive: true });

    closeBtn.addEventListener("click", () => {
      if (recognition) try { recognition.abort(); } catch (_) {}
      speechSynthesis.cancel();
      overlay.remove();
    });
  } catch (e) {
    alert(e.message || "Quiz playback failed.");
  }
}
