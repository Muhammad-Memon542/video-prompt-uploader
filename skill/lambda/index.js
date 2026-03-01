/**
 * Video Quiz – Answer-only flow for app-driven video.
 *
 * Your app plays the video; when the wait screen loads, the user invokes Alexa
 * once ("Alexa, open video quiz"), then Alexa asks for the answer, sends it to
 * your server, and speaks the result. Invocation cannot be skipped (Alexa
 * requires it), but it's a single phrase when the wait screen appears.
 *
 * Env:
 *   BASE_URL = https://your-ngrok-or-server.com  (required)
 *   TEST_SUBMISSION_ID = submission id for this quiz (required)
 *
 * Flow:
 *   1. App plays video → wait screen loads.
 *   2. User: "Alexa, open video quiz" → Launch: validate session, say "What's your answer?"
 *   3. User: "The answer is …" → AnswerIntent: POST verify, speak result.
 */

const BASE_URL = process.env.BASE_URL || "";
const TEST_SUBMISSION_ID = process.env.TEST_SUBMISSION_ID || "";

function getRequestHeaders() {
  const h = { "Content-Type": "application/json" };
  if (BASE_URL.includes("ngrok")) h["ngrok-skip-browser-warning"] = "1";
  return h;
}

async function getSession(submissionId) {
  const base = (BASE_URL || "").trim();
  if (!base) throw new Error("Set BASE_URL in the Lambda environment.");
  const url = `${base}/api/echo/session/${encodeURIComponent(submissionId)}`;
  const res = await fetch(url, { headers: getRequestHeaders() });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const preview = text.trim().slice(0, 80).replace(/\s+/g, " ");
    throw new Error(`Session API returned non-JSON (${res.status}). Response: ${preview}`);
  }
  if (!res.ok) throw new Error(data.error || "Session failed");
  return data; // { submissionId, questionText, expectedAnswer, timeline, ... }
}

async function verifyAnswer(submissionId, userAnswer) {
  const base = (BASE_URL || "").trim();
  if (!base) {
    throw new Error("Set BASE_URL in the Lambda environment to your backend URL (e.g. https://your-ngrok.ngrok.io).");
  }
  const url = `${base}/api/echo/verify`;
  const res = await fetch(url, {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify({ submissionId, userAnswer: String(userAnswer || "").trim() }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const preview = text.trim().slice(0, 80).replace(/\s+/g, " ");
    const hint = preview.startsWith("<!") || preview.toLowerCase().startsWith("<!doctype")
      ? " Backend returned HTML (e.g. ngrok warning page). Redeploy Lambda with latest code (ngrok-skip-browser-warning header) and confirm BASE_URL is your exact ngrok URL with no trailing slash."
      : "";
    throw new Error(
      `Backend returned non-JSON (status ${res.status}).${hint} Response starts with: ${preview}`
    );
  }
  if (!res.ok) throw new Error(data.error || "Verify failed");
  return data; // { correct, message }
}

function escapeSsml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function say(ssmlOrText, endSession = false) {
  const ssml = typeof ssmlOrText === "string" && ssmlOrText.startsWith("<speak>")
    ? ssmlOrText
    : `<speak>${escapeSsml(ssmlOrText)}</speak>`;
  return {
    version: "1.0",
    response: {
      outputSpeech: { type: "SSML", ssml },
      shouldEndSession: endSession,
    },
  };
}

/** Get user's answer from AnswerIntent – support common slot names. */
function getAnswerFromRequest(request) {
  const slots = request?.intent?.slots || {};
  // Try known slot names (match what you create in Alexa console)
  const value =
    slots.Answer?.value ??
    slots.answer?.value ??
    slots.Response?.value ??
    slots.response?.value;
  if (value) return value;
  // Fallback: first slot with a value
  for (const name of Object.keys(slots)) {
    const v = slots[name]?.value;
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

export const handler = async (event) => {
  const request = event?.request;
  const type = request?.type;
  const intent = request?.intent?.name;
  const session = event?.session || {};
  const attrs = session?.attributes || {};

  // Launch: validate session (video already played in app), then ask for answer only
  if (type === "LaunchRequest") {
    const submissionId = TEST_SUBMISSION_ID.trim();
    if (!submissionId) {
      return say(
        "Set TEST_SUBMISSION_ID in the Lambda environment to your quiz submission id, then try again.",
        true
      );
    }
    try {
      await getSession(submissionId); // validate quiz is ready; don't speak question (video played in app)
      return {
        version: "1.0",
        response: {
          outputSpeech: {
            type: "SSML",
            ssml: "<speak>What's your answer?</speak>",
          },
          shouldEndSession: false,
          sessionAttributes: { ...attrs, submissionId },
        },
      };
    } catch (e) {
      return say(`Sorry, couldn't load the quiz. ${escapeSsml(e.message || "Try again.")}`, true);
    }
  }

  // Answer intent: verify and speak result
  if (intent === "AnswerIntent") {
    const submissionId = attrs.submissionId || TEST_SUBMISSION_ID.trim();
    const userAnswer = getAnswerFromRequest(request);

    if (!submissionId) {
      return say("Open the skill again so we know which quiz you're answering.", true);
    }
    if (!userAnswer) {
      return say("I didn't catch that. What's your answer?", false);
    }

    try {
      const result = await verifyAnswer(submissionId, userAnswer);
      const message = result.message || (result.correct ? "That's right!" : "Not quite.");
      return say(message, true);
    } catch (e) {
      return say(`Sorry, something went wrong. ${escapeSsml(e.message || "Try again.")}`, true);
    }
  }

  // Unhandled (e.g. other intents)
  return say("What's your answer? You can say: the answer is, then your answer.", false);
};
