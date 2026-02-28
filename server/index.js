import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from project root
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- Paths ----------
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DATA_DIR = path.join(__dirname, "data");
const SUBMISSIONS_PATH = path.join(DATA_DIR, "submissions.json");
const TMP_DIR = path.join(__dirname, "tmp");
const VEO_DIR = path.join(__dirname, "veo_outputs");
const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(VEO_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

if (!fs.existsSync(SUBMISSIONS_PATH)) fs.writeFileSync(SUBMISSIONS_PATH, "[]", "utf-8");

// Serve generated assets
app.use("/veo", express.static(VEO_DIR));
app.use("/screenshots", express.static(SCREENSHOTS_DIR));

// ---------- Multer config ----------
const MAX_BYTES = 25 * 1024 * 1024; // 25MB

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (_req, file, cb) {
    const id = nanoid(10);
    const safeOriginal = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${id}_${safeOriginal}`);
  }
});

function fileFilter(_req, file, cb) {
  const allowed = new Set(["video/mp4", "video/webm", "video/quicktime"]); // mp4, webm, mov
  if (!allowed.has(file.mimetype)) {
    return cb(new Error("Only mp4, webm, or mov videos are allowed."), false);
  }
  cb(null, true);
}

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
  fileFilter
});

// ---------- Helpers ----------
function readSubmissions() {
  return JSON.parse(fs.readFileSync(SUBMISSIONS_PATH, "utf-8"));
}
function writeSubmissions(items) {
  fs.writeFileSync(SUBMISSIONS_PATH, JSON.stringify(items, null, 2), "utf-8");
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    let out = "";
    let err = "";

    if (p.stdout) p.stdout.on("data", (d) => (out += d.toString()));
    if (p.stderr) p.stderr.on("data", (d) => (err += d.toString()));

    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(`${cmd} exited ${code}\n${err}`));
    });
  });
}

// ---------- Screenshot helper ----------
async function ensureMidScreenshot(videoPath, submissionId) {
  const { out } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath
  ]);

  const durationSec = Number(String(out).trim());
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error("Could not read video duration (ffprobe).");
  }

  const midSec = durationSec / 2;
  const pngName = `${submissionId}_mid.png`;
  const pngPath = path.join(SCREENSHOTS_DIR, pngName);

  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(midSec),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    pngPath,
    "-y"
  ]);

  return { pngPath, midSec, screenshotUrl: `/screenshots/${pngName}` };
}

// ---------- Whisper helpers ----------
function parseSrt(srt) {
  const blocks = srt.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const items = [];
  const timeRe = /(\d\d:\d\d:\d\d[.,]\d\d\d)\s*-->\s*(\d\d:\d\d:\d\d[.,]\d\d\d)/;

  const toMs = (t) => {
    const [hh, mm, rest] = t.split(":");
    const restNorm = rest.replace(".", ",");
    const [ss, ms] = restNorm.split(",");
    return (+hh) * 3600000 + (+mm) * 60000 + (+ss) * 1000 + (+ms);
  };

  for (const b of blocks) {
    const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;
    const m = lines[1].match(timeRe);
    if (!m) continue;
    const text = lines.slice(2).join(" ");
    items.push({ startMs: toMs(m[1]), endMs: toMs(m[2]), text });
  }

  return items;
}

async function transcribeWithWhisperCpp(videoPath) {
  const modelPath = process.env.WHISPER_MODEL_PATH;
  if (!modelPath) throw new Error("Missing WHISPER_MODEL_PATH in .env (project root).");
  if (!fs.existsSync(modelPath)) throw new Error(`Model not found at: ${modelPath}`);

  const base = `a_${Date.now()}_${nanoid(6)}`;
  const wavPath = path.join(TMP_DIR, `${base}.wav`);
  const outPrefix = path.join(TMP_DIR, base);

  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    wavPath
  ]);

  await run("whisper-cli", ["-m", modelPath, "-f", wavPath, "-otxt", "-osrt", "-of", outPrefix]);

  const txtPath = `${outPrefix}.txt`;
  const srtPath = `${outPrefix}.srt`;

  const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, "utf-8").trim() : "";
  const srt = fs.existsSync(srtPath) ? fs.readFileSync(srtPath, "utf-8") : "";
  const segments = srt ? parseSrt(srt) : [];

  try { fs.unlinkSync(wavPath); } catch {}
  try { fs.unlinkSync(txtPath); } catch {}
  try { fs.unlinkSync(srtPath); } catch {}

  return { text, segments };
}

// ---------- Gemini (4-line output) ----------
function buildGeminiPrompt({ userGoal, segments, fullTranscript }) {
  const compactSegments = segments.slice(0, 220).map((s) => ({
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.text
  }));

  return `Return ONLY the 4 lines requested below. Do NOT include reasoning, analysis, evidence, markdown, or extra lines.

OUTPUT FORMAT (EXACTLY 4 LINES):
SHOW: <show name or Unknown>
LONGEST_BREAK_MS: <breakStartMs>-<breakEndMs> (<breakDurationMs>)
CLIP_1_QUESTION: <single-line voiceover script, EXACTLY 8 seconds, ends with a clear question>
CLIP_2_ANSWER: <single-line voiceover script, EXACTLY 8 seconds, immediately answers clip 1>

RULES:
- Both scripts must be SINGLE LINE (no newline characters). Use "..." for pauses.
- Educational and based on USER_GOAL.
- Do NOT imitate/impersonate any specific copyrighted character. Use show-inspired narrator vibe only.

USER_GOAL:
${userGoal}

TRANSCRIPT_SEGMENTS (ms):
${JSON.stringify(compactSegments)}

FULL_TRANSCRIPT:
${(fullTranscript || "").slice(0, 4000)}`.trim();
}

function parseGeminiFourLines(rawText) {
  const lines = String(rawText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const showLine = lines.find((l) => l.toUpperCase().startsWith("SHOW:")) || "";
  const breakLine = lines.find((l) => l.toUpperCase().startsWith("LONGEST_BREAK_MS:")) || "";
  const qLine = lines.find((l) => l.toUpperCase().startsWith("CLIP_1_QUESTION:")) || "";
  const aLine = lines.find((l) => l.toUpperCase().startsWith("CLIP_2_ANSWER:")) || "";

  const show = showLine.replace(/^SHOW:\s*/i, "").trim() || "Unknown";

  let breakStartMs = null, breakEndMs = null, breakDurationMs = null;
  const m = breakLine.match(/LONGEST_BREAK_MS:\s*(\d+)\s*-\s*(\d+)\s*\((\d+)\)/i);
  if (m) {
    breakStartMs = Number(m[1]);
    breakEndMs = Number(m[2]);
    breakDurationMs = Number(m[3]);
  }

  const clip1Question = qLine.replace(/^CLIP_1_QUESTION:\s*/i, "").trim();
  const clip2Answer = aLine.replace(/^CLIP_2_ANSWER:\s*/i, "").trim();

  return { show, longestBreak: { breakStartMs, breakEndMs, breakDurationMs }, clip1Question, clip2Answer };
}

async function callGeminiGenerateContent({ apiKey, model, promptText }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: promptText }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 900 }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(`Gemini error ${resp.status}: ${JSON.stringify(data)}`);

  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() || "";
}

// ---------- Veo helpers ----------
function getGenAIClient() {
  const key = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GOOGLE_API_KEY (or GEMINI_API_KEY) in .env");
  return new GoogleGenAI({ apiKey: key });
}

async function generateVeoClip({ prompt, outFile, referenceImages }) {
  const ai = getGenAIClient();

  let operation = await ai.models.generateVideos({
    model: "veo-3.1-generate-preview",
    prompt,
    config: {
      durationSeconds: 8,
      referenceImages
    }
  });

  while (!operation.done) {
    console.log("Waiting for video generation to complete...");
    await new Promise((r) => setTimeout(r, 10000));
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const videoFile = operation?.response?.generatedVideos?.[0]?.video;
  if (!videoFile) throw new Error("Veo returned no video file.");

  await ai.files.download({
    file: videoFile,
    downloadPath: outFile
  });

  return outFile;
}

function buildVeoPrompt({ showName, clipText, mode }) {
  const safeShow = showName && showName !== "Unknown" ? showName : "an animated show";
  const label = mode === "question" ? "QUESTION" : "ANSWER";

  return `Create an 8-second animated educational insert inspired by the vibe of ${safeShow}.
Use the provided reference image to match the scene's visual style/setting.
Tone: friendly narrator (not a specific character). Keep visuals simple and readable.
The narrator delivers this ${label} line clearly:
"${clipText}"`;
}

// ---------- Routes ----------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/upload", upload.single("video"), (req, res) => {
  try {
    const prompt = (req.body?.prompt ?? "").trim();
    if (!prompt) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(400).json({ ok: false, error: "Prompt is required." });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: "Video file is required." });

    const submission = {
      id: nanoid(12),
      createdAt: new Date().toISOString(),
      prompt,
      transcript: null,
      gemini: null,
      veo: null,
      file: {
        originalName: req.file.originalname,
        storedName: req.file.filename,
        path: req.file.path,
        sizeBytes: req.file.size,
        mimetype: req.file.mimetype
      }
    };

    const submissions = readSubmissions();
    submissions.unshift(submission);
    writeSubmissions(submissions);

    res.json({ ok: true, submission });
  } catch {
    res.status(500).json({ ok: false, error: "Server error." });
  }
});

app.get("/api/submissions", (_req, res) => {
  res.json({ ok: true, submissions: readSubmissions() });
});

app.post("/api/transcribe/:id", async (req, res) => {
  try {
    const submissions = readSubmissions();
    const idx = submissions.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "Submission not found." });

    const sub = submissions[idx];

    if (sub.transcript?.text && sub.transcript.text.trim().length > 0) {
      return res.json({ ok: true, transcript: sub.transcript, cached: true });
    }

    const { text, segments } = await transcribeWithWhisperCpp(sub.file.path);

    sub.transcript = {
      provider: "whisper.cpp",
      text,
      segments,
      createdAt: new Date().toISOString()
    };

    submissions[idx] = sub;
    writeSubmissions(submissions);

    res.json({ ok: true, transcript: sub.transcript, cached: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || "Transcription failed." });
  }
});

app.get("/api/screenshot/:id", async (req, res) => {
  try {
    const submissions = readSubmissions();
    const sub = submissions.find((s) => s.id === req.params.id);
    if (!sub) return res.status(404).json({ ok: false, error: "Submission not found." });

    const videoPath = sub.file.path;
    if (!fs.existsSync(videoPath)) return res.status(404).json({ ok: false, error: "Video file missing on disk." });

    const { screenshotUrl, midSec } = await ensureMidScreenshot(videoPath, sub.id);
    res.json({ ok: true, midSec, screenshotUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || "Screenshot failed." });
  }
});

app.post("/api/gemini/analyze/:id", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    if (!apiKey) return res.status(500).json({ ok: false, error: "Missing GEMINI_API_KEY (or GOOGLE_API_KEY) in .env" });

    const submissions = readSubmissions();
    const idx = submissions.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "Submission not found." });

    const sub = submissions[idx];
    const userGoal = sub.prompt || "";
    const segments = sub.transcript?.segments || [];
    const fullTranscript = sub.transcript?.text || "";

    if (!segments.length) {
      return res.status(400).json({ ok: false, error: "No timestamped transcript found. Run Transcribe first." });
    }

    const promptText = buildGeminiPrompt({ userGoal, segments, fullTranscript });
    const rawText = await callGeminiGenerateContent({ apiKey, model, promptText });
    const parsed = parseGeminiFourLines(rawText);

    sub.gemini = {
      model,
      createdAt: new Date().toISOString(),
      rawText,
      parsed
    };

    submissions[idx] = sub;
    writeSubmissions(submissions);

    res.json({ ok: true, gemini: sub.gemini });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || "Gemini analyze failed." });
  }
});

app.post("/api/veo/generate/:id", async (req, res) => {
  try {
    const submissions = readSubmissions();
    const idx = submissions.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false, error: "Submission not found." });

    const sub = submissions[idx];
    const parsed = sub.gemini?.parsed;
    if (!parsed?.clip1Question || !parsed?.clip2Answer) {
      return res.status(400).json({ ok: false, error: "Missing Gemini clips. Run Analyze with Gemini first." });
    }

    // Make/refresh screenshot and build reference image
    const { pngPath, screenshotUrl } = await ensureMidScreenshot(sub.file.path, sub.id);
    const screenshotReference = {
      image: {
        imageBytes: fs.readFileSync(pngPath).toString("base64"),
        mimeType: "image/png"
      },
      referenceType: "asset"
    };

    const showName = parsed.show || "Unknown";

    const prompt1 = buildVeoPrompt({ showName, clipText: parsed.clip1Question, mode: "question" });
    const prompt2 = buildVeoPrompt({ showName, clipText: parsed.clip2Answer, mode: "answer" });

    const clip1FileName = `${sub.id}_clip1.mp4`;
    const clip2FileName = `${sub.id}_clip2.mp4`;
    const clip1Path = path.join(VEO_DIR, clip1FileName);
    const clip2Path = path.join(VEO_DIR, clip2FileName);

    await generateVeoClip({
      prompt: prompt1,
      outFile: clip1Path,
      referenceImages: [screenshotReference]
    });

    await generateVeoClip({
      prompt: prompt2,
      outFile: clip2Path,
      referenceImages: [screenshotReference]
    });

    sub.veo = {
      updatedAt: new Date().toISOString(),
      referenceScreenshotUrl: screenshotUrl,
      clip1Url: `/veo/${clip1FileName}`,
      clip2Url: `/veo/${clip2FileName}`,
      prompts: { prompt1, prompt2 }
    };

    submissions[idx] = sub;
    writeSubmissions(submissions);

    res.json({ ok: true, veo: sub.veo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || "Veo generation failed." });
  }
});

// Multer errors (like file too large)
app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, error: "File must be under 25 MB." });
  }
  res.status(400).json({ ok: false, error: err?.message ?? "Upload failed." });
});

// Serve client
app.use(express.static(path.join(__dirname, "..", "client")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));