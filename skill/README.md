# Video Quiz – Alexa Skill (Echo Show 5)

## Answer-only setup (get it working first)

Use this flow to test only the **Answer** intent with your ngrok backend.

### 1. Lambda environment variables

In AWS Lambda → **Configuration** → **Environment variables**, set:

| Key | Value |
|-----|--------|
| `BASE_URL` | Your ngrok URL, e.g. `https://abc123.ngrok.io` (no trailing slash) |
| `TEST_SUBMISSION_ID` | A real submission ID from your app (one that has Gemini analyze done so it has an expected answer) |

### 2. Answer intent in Alexa Developer Console

- **Build** → **Interaction Model** → **Intents**
- Ensure you have an intent named **exactly** `AnswerIntent`.
- Add a **slot** to that intent:
  - **Slot name:** `Answer` (or `answer` – Lambda accepts both)
  - **Slot type:** `AMAZON.SearchQuery` (so the user can say a full phrase like "the answer is photosynthesis")
- **Sample utterances** (add several so Alexa recognizes the intent):
  - `the answer is {Answer}`
  - `my answer is {Answer}`
  - `{Answer}`

Save and **Build Model**.

### 3. Endpoint

- **Build** → **Endpoint**: default endpoint = your Lambda ARN. **Save Endpoints**.

### 4. Deploy Lambda code

- Zip `index.js` and `package.json` from `skill/lambda/` and upload to Lambda (or paste the code if using Alexa-Hosted).
- **Handler:** `index.handler`
- **Runtime:** Node.js 18.x or 20.x

### 5. Test

1. **Simulator:** Open your skill in the Alexa Developer Console **Test** tab.
2. Type or say: **"Open video quiz"** → skill should say "What's your answer?"
3. Then say: **"The answer is"** plus your answer (e.g. the expected answer text for that submission, or a paraphrase).
4. Skill should reply with "That's right!" or "Not quite. The answer was…"

If the skill says "I didn't catch that", the **Answer** slot didn't get a value – check the intent has a slot named `Answer` with type `AMAZON.SearchQuery` and utterances like "the answer is {Answer}".

---

## Full skill (later)

Minimal Lambda that talks to your backend (`/api/echo/session`, `/api/splice`, `/api/echo/verify`).

## 1. Set BASE_URL

In AWS Lambda → Configuration → Environment variables, add:

- **BASE_URL** = `https://your-ngrok-url.ngrok.io` (or your deployed server URL)

No trailing slash. Must be HTTPS.

## 2. Deploy the Lambda

- **Runtime:** Node.js 18.x or 20.x (for native `fetch`).
- **Handler:** `index.handler` (file `index.js`, export `handler`).
- Zip the contents of `skill/lambda/` (include `index.js` and `package.json`) and upload, or use AWS CLI / SAM / Serverless.

If you use the Alexa-Hosted option when creating the skill, you can replace the generated Lambda code with this handler and set BASE_URL in the Alexa-hosted Lambda env.

## 3. Interaction model (in Alexa Developer Console)

**Invocation name:** `video quiz`

**Intents:**

| Intent | Sample utterances | Slot |
|--------|-------------------|------|
| `PlayVideoQuizIntent` | "play quiz {SubmissionId}", "start {SubmissionId}", "play video quiz {SubmissionId}" | SubmissionId: AMAZON.SearchQuery (or AMAZON.Alphanumeric if you restrict IDs) |
| `AnswerIntent` | "the answer is {Answer}", "my answer is {Answer}", "{Answer}" | Answer: AMAZON.SearchQuery |

For testing you can use a single launch flow: add a custom slot `SubmissionId` and in the first turn say "play quiz" and when the skill asks "Which quiz?", use a second intent "GiveCodeIntent" with slot SubmissionId, or hardcode a submission ID in the Lambda for the first tests.

## 4. Skill endpoint

In the skill’s Build tab, set the default endpoint to your Lambda ARN. Save and build.

## 5. Test

- Simulator: launch skill, say the submission ID when asked, then give an answer.
- Echo Show 5: enable the skill and say "Alexa, open video quiz."

Video playback on the Show (play spliced video, pause at question end, resume after answer) is not in this Lambda; add that with [APL Video](https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/apl-video.html) or the [Video Skills Kit](https://developer.amazon.com/docs/video-skills-multimodal-devices/integration-overview.html) when you’re ready.
