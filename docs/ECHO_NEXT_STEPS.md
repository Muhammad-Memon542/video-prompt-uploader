# Echo integration – what to do next

Your **backend is ready**. These steps get the Echo Show 5 talking to it and running the full flow.

---

## 1. Expose your backend over HTTPS

Alexa can only call **HTTPS** endpoints. Locally, use a tunnel.

**Option A – ngrok (easiest for testing)**

```bash
# Install ngrok, then:
ngrok http 3000
```

Use the `https://xxxx.ngrok.io` URL as your **BASE_URL** in the skill. Restart ngrok each time unless you have a paid plan (URL changes).

**Option B – Deploy the server**

Deploy `server/` to a host that gives you HTTPS (e.g. Railway, Render, Fly.io, or a VPS with nginx + Let’s Encrypt). Use that URL as **BASE_URL**.

**Check:**  
`GET https://YOUR_BASE_URL/api/health` should return `{"ok":true}`.

---

## 2. Create an Alexa Developer account and a new skill

1. Go to [developer.amazon.com](https://developer.amazon.com) and sign in (or create an Amazon Developer account).
2. **Alexa** → **Skills** → **Create Skill**.
3. **Skill name:** e.g. "Video Quiz".
4. **Custom** model.
5. **Create your own** (or use Alexa-Hosted for a quick Lambda in the cloud).

---

## 3. Build the interaction model

In the skill’s **Build** tab → **Interaction Model**:

**Intents:**

| Intent name        | Sample utterances                          |
|--------------------|--------------------------------------------|
| `PlayVideoQuizIntent` | "play video quiz", "start", "play"      |
| `AnswerIntent`     | "the answer is {Answer}", "my answer is {Answer}" |
| `AnswerSlotIntent` | (optional) use slot type for free-form answer |

**Slot (if you use one):**

- Name: `Answer`
- Type: `AMAZON.SearchQuery` (free-form phrase) or a custom slot.

**Invocation:**

- Invocation name: e.g. "video quiz"  
- So the user says: "Alexa, open video quiz" or "Alexa, tell video quiz to play".

Save and build the model.

---

## 4. Implement the skill backend (Lambda or your endpoint)

The skill needs to:

1. **On launch or PlayVideoQuizIntent**
   - Ask for a submission ID (or use a default for testing), e.g. "Which quiz? Say the code."
   - Or hardcode a `submissionId` from your app for now.
   - Call `GET BASE_URL/api/echo/session/{submissionId}`.
   - Call `POST BASE_URL/api/splice` with `{ "submissionId": "<id>", "timestamp": <from session timeline.spliceTimestampMs> }` to get the video URL.
   - Store in session: `submissionId`, `videoUrl`, `timeline`, `expectedAnswer`.
   - For Echo Show 5: send a directive to **play the video** (see step 5). Then send a directive to **pause at** `timeline.questionEndMs` (or wait for a “paused at time” event if the video stack supports it).
   - Say: "What’s your answer?"

2. **On AnswerIntent (user says their answer)**
   - Get the transcript from the slot (e.g. `Answer` or the request’s intent slots).
   - Call `POST BASE_URL/api/echo/verify` with:
     - `{ "submissionId": "<id>", "userAnswer": "<transcript>" }`.
   - Speak the returned `message` (e.g. "That’s right!" or "Not quite. The answer was...").
   - Optionally resume video from `timeline.answerStartMs` if your video implementation supports it.

**Lambda (Node) example – calling your APIs:**

```js
const BASE_URL = process.env.BASE_URL || 'https://your-ngrok-url.ngrok.io';

async function getSession(submissionId) {
  const res = await fetch(`${BASE_URL}/api/echo/session/${submissionId}`);
  if (!res.ok) throw new Error('Session failed');
  return res.json();
}

async function getSpliceUrl(submissionId, timestampMs) {
  const res = await fetch(`${BASE_URL}/api/splice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submissionId, timestamp: timestampMs })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Splice failed');
  return `${BASE_URL.replace(/\/$/, '')}${data.outputUrl}`;
}

async function verifyAnswer(submissionId, userAnswer) {
  const res = await fetch(`${BASE_URL}/api/echo/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submissionId, userAnswer })
  });
  const data = await res.json();
  return data; // { correct, message }
}
```

Set **BASE_URL** in the Lambda environment to your ngrok or production URL.

---

## 5. Play video on Echo Show 5

Two main options:

**Option A – Alexa Video App (Video Skills Kit)**  
- Use the [Video Skill API](https://developer.amazon.com/en-US/docs/alexa/video/echo-show-video-skill-api-reference.html) and a **web player** that receives the video URL and handles play/pause.  
- Your Lambda sends the video URL to the device; the player loads it and can pause at `questionEndMs` (e.g. using a timer or `timeupdate`).  
- Best if you want full control (pause at exact time, then resume).

**Option B – APL with Video component**  
- Use [APL Video](https://developer.amazon.com/en-US/docs/alexa/alexa-presentation-language/apl-video.html) to play the URL on the Show.  
- You can send **ExecuteCommands** (e.g. SetValue to pause, or control playback) and use a timer or event to pause at `questionEndMs`.  
- Simpler than a full VSK web player; check APL Video docs for pause-at-time patterns.

For a **minimal path**: implement the voice flow first (launch → get session → ask “What’s your answer?” → verify → speak result). Add video playback once that works.

---

## 6. Configure the skill

- **Endpoint:** Your Lambda ARN (or HTTPS endpoint if you use a custom backend).
- **Permissions:** None required for basic HTTP calls from Lambda to your API.
- **Build** the skill and **Test** in the Alexa simulator or on the device.

---

## 7. Test on Echo Show 5

1. Use the same Amazon account as the developer account.
2. Enable the skill: Alexa app → Skills → Your skills → “Video Quiz” (or your name).
3. Say: “Alexa, open video quiz” (or your invocation).
4. Have a **submissionId** ready (from your app) that already has Gemini + Veo done and optionally a splice. Use it when the skill asks or hardcode it for testing.

---

## Quick test without the skill (verify backend)

From any machine with your server reachable (or ngrok URL):

```bash
# Replace SUBMISSION_ID and BASE_URL
curl -s "https://BASE_URL/api/echo/session/SUBMISSION_ID" | jq .

curl -s -X POST "https://BASE_URL/api/echo/verify" \
  -H "Content-Type: application/json" \
  -d '{"submissionId":"SUBMISSION_ID","userAnswer":"my answer here"}' | jq .
```

If both return valid JSON, the Echo integration backend is working; the rest is building the skill and video playback on the Show.

---

## Summary checklist

- [ ] Backend running and reachable over **HTTPS** (ngrok or deployed).
- [ ] Skill created in Alexa Developer Console.
- [ ] Interaction model: invocation + intents (e.g. PlayVideoQuiz, Answer).
- [ ] Lambda (or backend) calls: GET session, POST splice, POST verify.
- [ ] Lambda env var **BASE_URL** set to your HTTPS URL.
- [ ] Video on Show: add Video App or APL Video and pause at `questionEndMs` (can come after voice flow works).
- [ ] Test on Echo Show 5 with a real submission ID.
