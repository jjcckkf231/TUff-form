# KMITL Survey + Spinner Reward — Project Summary

## What this project is

A survey site for KMITL students: they sign in with a `@kmitl.ac.th` Google
account, answer an 8-question survey, then get one spin of a prize wheel for
a small chance (~1%, adaptive) at one of 6 real cash-pin codes. All data
(responses, spins, prizes) lives in a Google Sheet. There's no traditional
server — the backend is a Google Apps Script web app bound to that sheet.

Stack:
- **Frontend**: static HTML/CSS/JS ([index.html](index.html), [app.js](app.js),
  [styles.css](styles.css), [questions.json](questions.json), [config.js](config.js))
  — hostable anywhere static (GitHub Pages, Vercel, etc.)
- **Backend**: [backend/Code.gs](backend/Code.gs) + [backend/appsscript.json](backend/appsscript.json)
  — a Google Apps Script web app, deployed from inside a Google Sheet
- **Auth**: Google Identity Services, restricted to the `kmitl.ac.th` Google
  Workspace domain, re-verified server-side

## Objective

Collect 600 valid survey responses from KMITL students. Incentive is a
spin-the-wheel mechanic with 6 total cash prizes, using an *adaptive* drop
rate (`prizes_remaining / responses_remaining`, capped at 10%) so the odds
self-correct and the 6 prizes reliably get exhausted without ever risking
more than 6 payouts.

Full rationale and design (why not just embed a Google Form, the math behind
the adaptive drop rate, sheet schema, anti-fraud plan) is written up in
[KMITL_SURVEY.md](KMITL-~1.MD).

## What's been done

**Design & planning** — [KMITL_SURVEY.md](KMITL-~1.MD) fully specifies the
architecture, sheet schema, adaptive-drop-rate math, anti-fraud measures, and
build checklist.

**Backend implementation** (`backend/Code.gs`) — complete:
- `setupSheet` — creates 4 tabs (`Responses`, `Spins`, `Prizes`, `Config`),
  headers, protects the `Prizes` tab
- `setupSecrets` — generates the HMAC signing secret for session/spin tokens
- `doPost` routes: `startSurvey` (issues signed session token + server-side
  `t_start`), `submitSurvey` (validates, dedupes, flags, appends row, issues
  single-use spin token), `spin` (locked with `LockService`, computes
  adaptive `p`, CSPRNG roll, claims a prize row atomically)
- Server-side ID token verification (`aud`, `exp`, `hd === kmitl.ac.th`,
  `email_verified`)
- Quality flags implemented: `TOO_FAST` (duration below `min_duration_sec`),
  `STRAIGHTLINE` (identical answer index across all questions)
- Per-user rate limiting via `CacheService`
- Winner email via `MailApp`
- `raffleLeftovers` function for any unclaimed pins at campaign close

**Frontend implementation** — complete: landing/consent screen, GIS sign-in,
question renderer driven by `questions.json` (8 questions), spin wheel that
animates to a server-decided result, win/lose result screens.

**Docs** — [SETUP.md](SETUP.md) (step-by-step manual deployment guide) and
[CHROME_HANDOFF.md](CHROME_HANDOFF.md) (a handoff brief for finishing
deployment via a browser-driving agent, since the remaining steps need a
real signed-in Google session).

**Known, documented deviations from the original plan** (see SETUP.md
bottom): 8 questions instead of 6, `min_duration_sec` = 30 instead of 25,
`ip_hash`/`IP_CLUSTER` fraud flag not implemented (Apps Script can't see
caller IP without a paid add-on or proxy), reCAPTCHA v3 skipped as
unnecessary given domain-locked OAuth, rate limiting is per-user not per-IP.

## What hasn't been done

All of it is manual Google-console clicking that needs a real signed-in
browser session — none of it can be scripted from a CLI. Per
[config.js](config.js), which still holds placeholder values, **none of this
has been done yet**:

1. Create the Google Sheet and run `setupSheet` / `setupSecrets` in its
   bound Apps Script project
2. Replace the 6 `REPLACE_ME_n` placeholder prize codes in the `Prizes` tab
   with real cash-pin codes
3. Create a Google Cloud project, configure the OAuth consent screen, and
   create an OAuth Web application client ID with the frontend's hosting URL
   as an authorized origin
4. Add `OAUTH_CLIENT_ID` as a Script Property in Apps Script
5. Deploy the Apps Script as a web app ("Execute as: Me", "Access: Anyone")
   and copy the `/exec` URL
6. Fill in `config.js` with the real `BACKEND_URL` and `GOOGLE_CLIENT_ID`
7. Host the static frontend files somewhere (GitHub Pages / Vercel / etc.)
8. Full pre-launch test pass (non-KMITL account rejected, duplicate
   submission/spin rejected, forced `p_max=1` drains pool correctly with no
   duplicate codes, concurrent spins never double-claim a prize,
   `TOO_FAST` flag fires correctly, real phone test, winner email actually
   arrives)
9. Publish prize rules / PDPA consent copy, then launch and distribute the
   link

`CHROME_HANDOFF.md` was written specifically to hand steps 1–6 to a
browser-driving agent under the `poompitaya@gmail.com` account — that
handoff has not been executed yet (or wasn't completed) as of this summary.
