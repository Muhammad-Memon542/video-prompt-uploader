# Echo (Alexa) Integration – Design

Target device: **Amazon Echo Show 5**.

## End-to-end flow (step by step)

1. **Application (elsewhere)** starts a “session” for a given submission (video + question/answer clips).
   - Option A: Web client starts playback of the spliced video and, at the question end, pauses and notifies the backend “ready for answer.”
   - Option B: Echo Show runs an Alexa Skill that plays the video on the device; the skill knows when the question clip ends and pauses.

2. **Video plays** (spliced: intro → question clip → answer clip → rest).
   - Question clip = 8s Veo clip with the narrator asking the question (`clip1Question`).
   - After that clip, playback **pauses**.

3. **Echo activates** (voice).
   - Alexa says something like: “What’s your answer?” or “Tell me the answer.”
   - User speaks their answer.

4. **Echo sends the answer to our backend** (transcript from Alexa’s speech-to-text).
   - `POST /api/echo/verify` with `{ submissionId, sessionId?, userAnswer }`.

5. **We verify** the answer against the expected answer (`gemini.parsed.clip2Answer`).
   - Comparison: fuzzy / semantic (not exact string match), e.g. normalize text + similarity or keyword overlap.
   - Return `{ correct: true|false, message?: string }`.

6. **Echo says “Right” or “Wrong”** using our response.

7. **Video continues** (answer clip + rest of video).
   - Either the other app resumes playback, or the Alexa Skill resumes the video on the Show.

---

## What we build (this repo)

### 1. Session / content API for Echo

So the Echo (or the “application elsewhere”) can get everything needed to play and pause at the right time.

- **GET /api/echo/session/:submissionId**
  - Returns:
    - `submissionId`, `prompt`
    - `questionText`: `gemini.parsed.clip1Question` (what the narrator says)
    - `expectedAnswer`: `gemini.parsed.clip2Answer` (what we compare against)
    - `splicedVideoUrl`: full URL to the spliced video (or instructions to call `/api/splice` first if not yet generated)
    - `timeline`: e.g. `{ questionEndMs, answerStartMs }` so the client/skill knows when to pause (after question) and when the “answer” clip starts
  - Requires submission to have gone through: Gemini analyze + Veo generate + (optionally) splice. If spliced URL not ready, we can return `spliceTimestampMs` and they can splice on demand.

### 2. Answer verification API

Used by the Alexa Skill (or any client) after the user speaks.

- **POST /api/echo/verify**
  - Body: `{ submissionId, userAnswer }` (optional: `sessionId` for logging).
  - We load the submission, get `gemini.parsed.clip2Answer`, compare with `userAnswer` (normalize + similarity or keyword match).
  - Response: `{ correct: boolean, message?: string }` so Echo can say “Right” or “Wrong” (and optionally `message` for a short hint).

### 3. Verification logic

- Normalize: lowercase, trim, collapse whitespace, remove punctuation.
- Consider:
  - **Exact match** after normalize (strict).
  - **Keyword overlap**: significant words in `expectedAnswer` present in `userAnswer` (e.g. 70% of words).
  - **Semantic similarity** (optional): embed both with Gemini and compare cosine similarity above a threshold.
- First version: normalize + keyword overlap + optional exact match fallback. Add semantic later if needed.

---

## What the Alexa Skill (Echo) does (outside this repo)

- **Account linking** (optional): link to our backend so requests are authenticated.
- **Start session**: get content via `GET /api/echo/session/:submissionId` (submissionId might come from “Play video X” or a deep link).
- **Play video on Show**: use Alexa Presentation Language (APL) or Video App directives to play `splicedVideoUrl`; use timeline to pause at `questionEndMs`.
- **When paused**: prompt “What’s your answer?” and open for voice input.
- **On user answer**: call `POST /api/echo/verify` with `submissionId` and `userAnswer` (transcript from Alexa).
- **Speak result**: “That’s right!” / “Not quite. The answer was …” using our `correct` and optional `message`.
- **Resume video** from `answerStartMs` or from current position.

---

## Timeline (spliced video)

The spliced file is: `[ part1 (0 → timestampMs ) | clip1 (question) | clip2 (answer) | part2 (rest) ]`.

- `part1DurationMs` = `timestampMs`
- `clip1DurationMs` = 8000 (Veo 8s)
- `clip2DurationMs` = 8000
- So:
  - **questionEndMs** = `timestampMs + 8000`
  - **answerStartMs** = `timestampMs + 8000` (same as question end)
  - **answerEndMs** = `timestampMs + 16000`

We can return these in the session API so the Echo knows exactly when to pause and when to resume.

---

## Security (later)

- No auth in the first version; submission IDs are unguessable (nanoid).
- Later: API key for the Skill, or account linking and scope submissions by user.

---

## File changes (this repo)

| File | Change |
|------|--------|
| `server/index.js` | Add `GET /api/echo/session/:submissionId`, `POST /api/echo/verify`, verification helper |
| `docs/ECHO_INTEGRATION.md` | This design doc |

No client changes required for the Echo itself; the “application elsewhere” or the Alexa Skill consumes these APIs.

---

## Alexa Skill (Echo Show 5) – implementation checklist

When you build the skill in the Alexa Developer Console (or ASK CLI):

1. **Invocation** – e.g. "Open [Your Skill Name]" or "Play video quiz [submission id]".
2. **Get content** – Call `GET {BASE_URL}/api/echo/session/:submissionId` to get `questionText`, `expectedAnswer`, `timeline`, and splice instructions.
3. **Get video URL** – Call `POST {BASE_URL}/api/splice` with body `{ submissionId, timestamp: timeline.spliceTimestampMs }` to get `outputUrl`. Prepend your server base URL to get full video URL.
4. **Play video on Show** – Use Alexa Video App interface or APL Video to play the spliced video. Pause at `timeline.questionEndMs` (milliseconds).
5. **Prompt for answer** – When paused, say "What's your answer?" and capture the next utterance (custom intent or slot).
6. **Verify** – Call `POST {BASE_URL}/api/echo/verify` with body `{ submissionId, userAnswer: "<transcript>" }`. Use returned `correct` and `message` for the reply.
7. **Resume** – Speak `message` then resume video from `timeline.answerStartMs`.
8. **Hosting** – Backend must be HTTPS and reachable from Alexa (public URL or ngrok for testing). CORS is enabled for API routes.
