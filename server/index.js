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

// Splice output dir
const EAVS_DIR = path.join(__dirname, "EAVs");

// Ensure dirs exist
[UPLOAD_DIR, DATA_DIR, TMP_DIR, VEO_DIR, SCREENSHOTS_DIR, EAVS_DIR].forEach((d) =>
  fs.mkdirSync(d, { recursive: true })
);

// Ensure submissions storage exists
if (!fs.existsSync(SUBMISSIONS_PATH)) fs.writeFileSync(SUBMISSIONS_PATH, "[]", "utf-8");

// Serve generated assets
app.use("/veo", express.static(VEO_DIR));
app.use("/screenshots", express.static(SCREENSHOTS_DIR));
app.use("/eavs", express.static(EAVS_DIR));

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

// Env-configurable bins
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const FFPROBE_BIN =
  process.env.FFPROBE_BIN ||
  (typeof FFMPEG_BIN === "string"
    ? FFMPEG_BIN.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1")
    : "ffprobe");
const WHISPER_BIN = process.env.WHISPER_BIN || "whisper-cli";

// ---------- ffprobe: audio presence ----------
async function hasAudioStream(filePath) {
  try {
    const { out } = await run(FFPROBE_BIN, [
      "-v",
      "error",
      "-select_streams",
      "a",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      filePath
    ]);
    return String(out || "").trim().length > 0;
  } catch {
    return false;
  }
}

// ---------- Screenshot helper ----------
async function ensureMidScreenshot(videoPath, submissionId) {
  const { out } = await run(FFPROBE_BIN, [
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

  await run(FFMPEG_BIN, [
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
  const blocks = srt
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const items = [];
  const timeRe = /(\d\d:\d\d:\d\d[.,]\d\d\d)\s*-->\s*(\d\d:\d\d:\d\d[.,]\d\d\d)/;

  const toMs = (t) => {
    const [hh, mm, rest] = t.split(":");
    const restNorm = rest.replace(".", ",");
    const [ss, ms] = restNorm.split(",");
    return +hh * 3600000 + +mm * 60000 + +ss * 1000 + +ms;
  };

  for (const b of blocks) {
    const lines = b
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
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

  await run(FFMPEG_BIN, [
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

  await run(WHISPER_BIN, ["-m", modelPath, "-f", wavPath, "-otxt", "-osrt", "-of", outPrefix]);

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

  let breakStartMs = null,
    breakEndMs = null,
    breakDurationMs = null;
  const m = breakLine.match(/LONGEST_BREAK_MS:\s*(\d+)\s*-\s*(\d+)\s*\((\d+)\)/i);
  if (m) {
    breakStartMs = Number(m[1]);
    breakEndMs = Number(m[2]);
    breakDurationMs = Number(m[3]);
  }

  const clip1Question = qLine.replace(/^CLIP_1_QUESTION:\s*/i, "").trim();
  const clip2Answer = aLine.replace(/^CLIP_2_ANSWER:\s*/i, "").trim();

  return {
    show,
    longestBreak: { breakStartMs, breakEndMs, breakDurationMs },
    clip1Question,
    clip2Answer
  };
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

// ---------- FIXED: splice that uses generated VEO clips ----------
async function probeVideoProps(filePath) {
  // width, height, fps (as float)
  const { out } = await run(FFPROBE_BIN, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,r_frame_rate",
    "-of",
    "json",
    filePath
  ]);

  const json = JSON.parse(String(out || "{}"));
  const s = json?.streams?.[0] || {};
  const width = Number(s.width) || 1280;
  const height = Number(s.height) || 720;

  // r_frame_rate like "30000/1001" or "30/1"
  let fps = 30;
  if (typeof s.r_frame_rate === "string" && s.r_frame_rate.includes("/")) {
    const [a, b] = s.r_frame_rate.split("/").map(Number);
    if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) {
      const v = a / b;
      if (Number.isFinite(v) && v > 0 && v < 240) fps = v;
    }
  }

  return { width, height, fps };
}

/**
 * ✅ Robust splice:
 * - Splits original at timestamp
 * - Inserts clip1 + clip2
 * - NORMALIZES all segments (scale + sar + fps + pix_fmt)
 * - Ensures audio exists for every segment (adds silence if missing)
 */
async function spliceWithGeneratedClips({ originalPath, timestampMs, clip1Path, clip2Path, outputPath }) {
  const tsSec = Math.max(0, Number(timestampMs) / 1000);

  // Use ORIGINAL video as the "truth" for size/fps
  const { width, height, fps } = await probeVideoProps(originalPath);

  const a0 = await hasAudioStream(originalPath);
  const a1 = await hasAudioStream(clip1Path);
  const a2 = await hasAudioStream(clip2Path);

  // For any clip without audio, we synthesize silent audio so concat can run with audio
  // We'll always output audio (aac) to keep "normal" MP4 behavior.
  const needSilence1 = !a1;
  const needSilence2 = !a2;

  // video normalization applied to every segment
  // - scale to original size
  // - force SAR 1:1
  // - force fps
  // - force pixel format
  const V = (labelIn, labelOut) =>
    `[${labelIn}]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps.toFixed(
      3
    )},format=yuv420p,setpts=PTS-STARTPTS[${labelOut}]`;

  // audio normalization
  const A = (labelIn, labelOut) => `[${labelIn}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[${labelOut}]`;

  // Build filtergraph
  // Inputs:
  // 0 = original, 1 = clip1, 2 = clip2
  //
  // Create:
  // - v0/a0 = original part A (0..ts)
  // - v3/a3 = original part B (ts..end)
  // - v1/a1 = clip1 normalized + optional silent audio
  // - v2/a2 = clip2 normalized + optional silent audio
  //
  // Then concat n=4
  const parts = [];

  // Original Part A
  parts.push(`[0:v]trim=0:${tsSec},setpts=PTS-STARTPTS[v0raw]`);
  parts.push(V("v0raw", "v0"));
  if (a0) {
    parts.push(`[0:a]atrim=0:${tsSec},asetpts=PTS-STARTPTS[a0raw]`);
    parts.push(A("a0raw", "a0"));
  } else {
    // extremely rare: original has no audio
    parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:${tsSec},asetpts=PTS-STARTPTS[a0]`);
  }

  // Original Part B
  parts.push(`[0:v]trim=${tsSec},setpts=PTS-STARTPTS[v3raw]`);
  parts.push(V("v3raw", "v3"));
  if (a0) {
    parts.push(`[0:a]atrim=${tsSec},asetpts=PTS-STARTPTS[a3raw]`);
    parts.push(A("a3raw", "a3"));
  } else {
    parts.push(`anullsrc=r=48000:cl=stereo,asetpts=PTS-STARTPTS[a3]`);
  }

  // Clip1 video
  parts.push(V("1:v", "v1"));
  if (needSilence1) {
    // make ~8s silent audio for clip1 (your clips are 8s)
    parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:8,asetpts=PTS-STARTPTS[a1]`);
  } else {
    parts.push(A("1:a", "a1"));
  }

  // Clip2 video
  parts.push(V("2:v", "v2"));
  if (needSilence2) {
    parts.push(`anullsrc=r=48000:cl=stereo,atrim=0:8,asetpts=PTS-STARTPTS[a2]`);
  } else {
    parts.push(A("2:a", "a2"));
  }

  // Concat all 4
  parts.push(`[v0][a0][v1][a1][v2][a2][v3][a3]concat=n=4:v=1:a=1[v][a]`);

  const filter = parts.join(";");

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    originalPath,
    "-i",
    clip1Path,
    "-i",
    clip2Path,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-y",
    outputPath
  ];

  await run(FFMPEG_BIN, args);
  return outputPath;
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

/**
 * ✅ FIXED /api/splice
 * - If submissionId provided: uses generated VEO clips for that submission.
 * - If not: falls back to server/temp/v1.mp4 and v2.mp4 (legacy).
 * - Splices by splitting original at timestamp and inserting clips in between.
 */
app.post("/api/splice", upload.single("video"), async (req, res) => {
  try {
    const { timestamp, submissionId } = req.body;

    if (!timestamp) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(400).json({ ok: false, error: "timestamp is required." });
    }

    const timestampMs = Number.parseInt(String(timestamp), 10);
    if (!Number.isFinite(timestampMs) || timestampMs < 0) {
      if (req.file?.path) fs.unlinkSync(req.file.path);
      return res.status(400).json({ ok: false, error: "timestamp must be a non-negative integer (ms)." });
    }

    // Determine main video path
    let mainVideoPath = null;
    let sub = null;

    if (submissionId) {
      const submissions = readSubmissions();
      sub = submissions.find((s) => s.id === submissionId);
      if (!sub) return res.status(404).json({ ok: false, error: "Submission not found." });

      mainVideoPath = sub.file?.path;
      if (!mainVideoPath || !fs.existsSync(mainVideoPath)) {
        return res.status(404).json({ ok: false, error: "Stored video file not found." });
      }
    } else if (req.file?.path) {
      mainVideoPath = req.file.path;
    } else {
      return res.status(400).json({ ok: false, error: "Either upload a video or provide a submissionId." });
    }

    // Determine clip paths:
    // 1) Prefer VEO-generated clips if submissionId exists and veo outputs exist
    // 2) Otherwise fallback to server/temp/v1.mp4 and v2.mp4
    let clip1Path = null;
    let clip2Path = null;

    if (sub?.id) {
      const expected1 = path.join(VEO_DIR, `${sub.id}_clip1.mp4`);
      const expected2 = path.join(VEO_DIR, `${sub.id}_clip2.mp4`);
      if (fs.existsSync(expected1) && fs.existsSync(expected2)) {
        clip1Path = expected1;
        clip2Path = expected2;
      } else if (sub.veo?.clip1Url && sub.veo?.clip2Url) {
        // If URLs exist but files were moved, reconstruct disk path from URL
        const f1 = path.basename(sub.veo.clip1Url);
        const f2 = path.basename(sub.veo.clip2Url);
        const p1 = path.join(VEO_DIR, f1);
        const p2 = path.join(VEO_DIR, f2);
        if (fs.existsSync(p1) && fs.existsSync(p2)) {
          clip1Path = p1;
          clip2Path = p2;
        }
      }
    }

    // Fallback legacy clips (partner setup)
    if (!clip1Path || !clip2Path) {
      const tempDir = path.join(__dirname, "temp");
      const legacy1 = path.join(tempDir, "v1.mp4");
      const legacy2 = path.join(tempDir, "v2.mp4");
      if (fs.existsSync(legacy1) && fs.existsSync(legacy2)) {
        clip1Path = legacy1;
        clip2Path = legacy2;
      }
    }

    if (!clip1Path || !clip2Path) {
      return res.status(500).json({
        ok: false,
        error:
          "AI clips not found. Generate VEO clips first, or provide legacy clips at server/temp/v1.mp4 and v2.mp4."
      });
    }

    const outputFileName = `spliced_${Date.now()}_${nanoid(10)}.mp4`;
    const outputFile = path.join(EAVS_DIR, outputFileName);

    await spliceWithGeneratedClips({
      originalPath: mainVideoPath,
      timestampMs,
      clip1Path,
      clip2Path,
      outputPath: outputFile
    });

    // Clean up uploaded temp main video if used (no submissionId)
    if (!submissionId && req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }

    res.json({
      ok: true,
      output: outputFile,
      outputFileName,
      outputUrl: `/eavs/${outputFileName}`
    });
  } catch (err) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ ok: false, error: err?.message || "Splice failed." });
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