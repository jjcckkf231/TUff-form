# Setup & Deploy

Everything from `KMITL-~1.MD` is built. This is the remaining manual wiring —
none of it can be scripted from here because it requires clicking through
your own Google account.

## 1. Spreadsheet + Apps Script backend

1. Create a new Google Sheet (this becomes your data store).
2. Extensions → Apps Script. Delete the default `Code.gs` content.
3. Copy [backend/Code.gs](backend/Code.gs) into the editor.
4. Project Settings (gear icon) → check "Show appsscript.json" → replace its
   contents with [backend/appsscript.json](backend/appsscript.json).
5. Back in the editor, select the `setupSheet` function from the dropdown → Run.
   Approve the permission prompts. This creates the 4 tabs and protects `Prizes`.
6. Select `setupSecrets` → Run. This generates the HMAC signing secret used
   for session/spin tokens.
7. Open the `Prizes` tab in the Sheet and replace the 6 `REPLACE_ME_n`
   placeholder codes with your real pin codes.

## 2. OAuth client (for the `@kmitl.ac.th` restriction)

1. [Google Cloud Console](https://console.cloud.google.com) → new project (or reuse one).
2. APIs & Services → OAuth consent screen → External, fill minimal info, publish.
3. APIs & Services → Credentials → Create Credentials → OAuth client ID → **Web application**.
4. Authorized JavaScript origins: add wherever you'll host the frontend, e.g.
   `https://yourname.github.io` or your Vercel URL. (`http://localhost:5500` etc. for local testing.)
5. Copy the Client ID.
6. Back in Apps Script: Project Settings → Script Properties → add
   `OAUTH_CLIENT_ID` = that client ID.

## 3. Deploy the backend

1. In Apps Script: Deploy → New deployment → type **Web app**.
2. Execute as: **Me**. Who has access: **Anyone**.
3. Deploy, copy the `/exec` URL.

## 4. Wire the frontend

Edit [config.js](config.js):

```js
window.APP_CONFIG = {
  BACKEND_URL: 'https://script.google.com/macros/s/.../exec',   // from step 3
  GOOGLE_CLIENT_ID: '....apps.googleusercontent.com',            // from step 2
  HOSTED_DOMAIN: 'kmitl.ac.th'
};
```

Then host [index.html](index.html), [styles.css](styles.css), [app.js](app.js),
[config.js](config.js), and [questions.json](questions.json) together as static
files — GitHub Pages, Vercel, or any static host. They must all sit in the
same directory (relative paths).

## 5. Test before launch (from the build plan's checklist)

- [ ] Sign in with a non-`@kmitl.ac.th` Google account → rejected with a clear message
- [ ] Complete the survey, spin, then reload and try again with the same account → rejected at both steps
- [ ] In the `Config` tab, temporarily set `p_max` to `1` → confirm wins drain the pool and the 7th winner gets `LOSE` with no duplicate codes issued
- [ ] Fire several spins back-to-back (multiple browser profiles) → check the `Spins` tab never has two `WIN` rows pointing at the same `prize_id`
- [ ] Try answering in under `min_duration_sec` → the `Responses.flags` column shows `TOO_FAST`
- [ ] Full run on an actual phone, on mobile data (not just wifi)
- [ ] Confirm the winner email actually arrives (check spam folder too)

When you're done testing, reset any rows you created in `Responses`/`Spins`/`Prizes`
before real launch, and set `Prizes` back to `AVAILABLE` for any codes you drained.

## 6. Closing the campcampaign

At 600 responses or your deadline: set `Config.campaign_open` to `FALSE`
(this blocks new `startSurvey` calls immediately). If pins are left in
`Prizes` with status `AVAILABLE`, run the `raffleLeftovers` function from the
Apps Script editor — it logs winners to the execution log; email codes to
them manually and mark those rows `CLAIMED`.

---

## Deviations from the build plan, and why

- **8 questions, not 6.** `questions.json` has `q1`–`q8`. The backend, sheet
  schema, and frontend all use 8 to match the actual survey content instead
  of the plan's placeholder count.
- **`min_duration_sec` defaults to 30, not 25** — bumped slightly since 8
  questions take a bit longer than 6 to answer honestly. Tune it live in the
  `Config` tab any time.
- **`ip_hash` column exists but is left empty**, and `IP_CLUSTER` flagging is
  **not implemented**. Apps Script's `doPost(e)` has no access to the
  caller's IP address — there's no clean way to get it without a paid
  service or a Cloudflare Worker sitting in front of the endpoint as a
  proxy. `TOO_FAST` and `STRAIGHTLINE` flags are both implemented and cover
  most low-effort bot/spam submissions on their own. If IP tracking turns
  out to matter, that's a follow-up, not a blocker for launch.
- **reCAPTCHA v3 was skipped.** The plan itself calls the domain-locked
  OAuth "95% of the work" here; reCAPTCHA is real but genuinely optional
  extra insurance, not needed to launch safely at 600-response scale.
- **Rate limiting is per authenticated user** (`CacheService`, 10 req/min on
  `startSurvey`), not per IP — same reason as above (no IP available).
  Since every write requires a verified `@kmitl.ac.th` sign-in first, this
  covers the realistic abuse case (one student mashing the button).
