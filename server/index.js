import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from project root
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const app = express();
app.use(cors());

// ---------- Paths ----------
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DATA_DIR = path.join(__dirname, "data");
const SUBMISSIONS_PATH = path.join(DATA_DIR, "submissions.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SUBMISSIONS_PATH)) fs.writeFileSync(SUBMISSIONS_PATH, "[]", "utf-8");

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

async function transcribeWithWhisperCpp(videoPath) {
  const modelPath = process.env.WHISPER_MODEL_PATH;
  if (!modelPath) throw new Error("Missing WHISPER_MODEL_PATH in .env (project root).");
  if (!fs.existsSync(modelPath)) throw new Error(`Model not found at: ${modelPath}`);

  // 1) Extract audio to wav (16kHz mono)
  const tmpDir = path.join(__dirname, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const base = `a_${Date.now()}_${nanoid(6)}`;
  const wavPath = path.join(tmpDir, `${base}.wav`);

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

  // 2) Run whisper.cpp CLI
  // Homebrew installs a CLI called `whisper-cpp` (check with `whisper-cpp -h`). :contentReference[oaicite:3]{index=3}
  // -otxt outputs a .txt file; -of sets output prefix
  const outPrefix = path.join(tmpDir, base);

  await run("whisper-cli", [
    "-m",
    modelPath,
    "-f",
    wavPath,
    "-otxt",
    "-of",
    outPrefix
  ]);

  const txtPath = `${outPrefix}.txt`;
  const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, "utf-8").trim() : "";

  // Cleanup (best-effort)
  try { fs.unlinkSync(wavPath); } catch {}
  try { fs.unlinkSync(txtPath); } catch {}

  return text;
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

    // cache only if non-empty
    if (sub.transcript?.text && sub.transcript.text.trim().length > 0) {
      return res.json({ ok: true, transcript: sub.transcript, cached: true });
    }

    const text = await transcribeWithWhisperCpp(sub.file.path);

    sub.transcript = {
      provider: "whisper.cpp",
      text,
      createdAt: new Date().toISOString()
    };

    submissions[idx] = sub;
    writeSubmissions(submissions);

    res.json({ ok: true, transcript: sub.transcript, cached: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || "Transcription failed." });
  }
});

// Multer errors (like file too large)
app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, error: "File must be less than 25 MB." });
  }
  res.status(400).json({ ok: false, error: err?.message ?? "Upload failed." });
});

// Serve client
app.use(express.static(path.join(__dirname, "..", "client")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
