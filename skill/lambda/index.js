/**
 * Video Quiz – Answer intent only.
 *
 * Env:
 *   BASE_URL = https://your-ngrok-or-server.com  (required)
 *   TEST_SUBMISSION_ID = your submission id      (required for testing – used on Launch)
 *
 * Flow:
 *   1. User: "Alexa, open video quiz" → Launch: we store TEST_SUBMISSION_ID, say "What's your answer?"
 *   2. User: "The answer is photosynthesis" → AnswerIntent: we call verify, speak result.
 */

const BASE_URL = process.env.BASE_URL || "";
const TEST_SUBMISSION_ID = process.env.TEST_SUBMISSION_ID || "";

async function verifyAnswer(submissionId, userAnswer) {
  const base = (BASE_URL || "").trim();
  if (!base) {
    throw new Error("Set BASE_URL in the Lambda environment to your backend URL (e.g. https://your-ngrok.ngrok.io).");
  }
  const url = `${base}/api/echo/verify`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "1",
    },
    body: JSON.stringify({ submissionId, userAnswer: String(userAnswer || "").trim() }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const preview = text.trim().slice(0, 80).replace(/\s+/g, " ");
    throw new Error(
      `Backend returned non-JSON (status ${res.status}). Check BASE_URL and that the server is running. Response starts with: ${preview}`
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

  // Launch: store submission id (from env) and ask for answer
  if (type === "LaunchRequest") {
    const submissionId = TEST_SUBMISSION_ID.trim();
    if (!submissionId) {
      return say(
        "Set TEST_SUBMISSION_ID in the Lambda environment to your quiz submission id, then try again.",
        true
      );
    }
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
