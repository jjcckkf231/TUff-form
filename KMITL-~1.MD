# KMITL Survey + Spinner Reward — Build Plan

**Goal:** 600 valid responses from KMITL students on a 6-question survey. Incentive = one spin per person for a 1% chance at a real cash-pin code. 6 pins total.

**Decisions locked in:** adaptive drop rate · Google sign-in restricted to `@kmitl.ac.th` · results land in Google Sheets.

---

## 1. The Google Forms problem (read this first)

You wanted to keep the Google Form and layer your site on top. **That doesn't work**, for one specific reason:

> The Google Forms API can create forms, read form structure, and **read** responses. It cannot **submit** a response. There is no `responses.create` method. It's been an open feature request since 2023.

So the three routes are:

| Route | Verdict |
|---|---|
| **A. Custom survey UI → write to Sheets yourself** | ✅ **Do this.** Full control over timer, identity, spin gate. Data still lands in a Google Sheet. |
| B. Custom UI → POST to the form's hidden `/formResponse` endpoint | ⚠️ Unofficial scraping trick. Works today, no success confirmation, silently breaks when Google changes the form. Can't add your own columns (duration, spin result) without adding fake questions. |
| C. Embed the real form in an `<iframe>` | ❌ Dead end. Cross-origin means you cannot detect submission, so you can't gate the spinner or run a real timer. |

**Route A does not mean you lose the Google Form.** Keep the form as the *authoring* surface: your build script reads it once via the Forms API (`forms.get`, scope `forms.body.readonly`) and exports the 6 questions to a JSON config your site renders. Edit the form, re-run the import, site updates. If that's more plumbing than it's worth for 6 questions, just hand me the questions and I'll write the JSON directly.

---

## 2. Architecture

Everything free, everything inside Google.

```
[ Static frontend ]                    [ Apps Script Web App ]        [ Google Sheet ]
  Vercel / GH Pages                      doPost() endpoints             (bound script)
        │                                        │                            │
   Google Identity Services  ──ID token──►  verify token                      │
        │                                   hd == kmitl.ac.th                 │
   render 6 questions   ◄──session token──  issue signed token + t_start      │
        │                                        │                            │
   submit answers       ──────────────────►  validate, dedupe ──────────────► Responses
        │                                        │                            │
   click SPIN           ──────────────────►  LockService mutex ─────────────► Spins
   (wheel is cosmetic)  ◄───result+code────  adaptive roll, claim pin ──────► Prizes
```

**Why Apps Script as the backend:** the prize claim must be atomic — two people spinning at the same millisecond must not both get pin #4. `LockService.getScriptLock()` gives you a real global mutex, and `appendRow()` is atomic. That's the one hard correctness requirement, and Apps Script covers it for free with data natively in Sheets. No server, no database, no bill.

**Frontend:** plain HTML + JS, or React if you prefer. Single page, three screens. Host free on GitHub Pages, Vercel, or even Apps Script's own HTML service.

**Upgrade path (only if needed):** if 600 becomes 6,000, swap the backend for Supabase Postgres with a `SELECT ... FOR UPDATE` on the prize row, and mirror to Sheets nightly. Not needed at your scale.

---

## 3. Sheet schema

Four tabs in one spreadsheet.

**`Responses`**

| Column | Notes |
|---|---|
| `response_id` | UUID |
| `user_id` | Google `sub` claim — the stable user ID. **Not** the email string. |
| `email` | For contacting winners |
| `started_at` / `submitted_at` | ISO timestamps, both server-side |
| `duration_sec` | Computed server-side |
| `q1`–`q6` | Answers |
| `ip_hash` | SHA-256(IP + secret salt). Never store raw IP. |
| `flags` | e.g. `TOO_FAST,STRAIGHTLINE` — empty for clean rows |

**`Spins`** — `spin_id`, `user_id`, `spun_at`, `p_used`, `roll`, `result` (WIN/LOSE), `prize_id`

Logging `p_used` and `roll` is what lets you prove the draw was fair if a student complains.

**`Prizes`** — `prize_id`, `code`, `status` (AVAILABLE/CLAIMED), `claimed_by`, `claimed_at`

> ⚠️ **Protect this tab.** Data → Protect sheet, restrict to yourself. The 6 codes are literal money. The backend only ever returns one code, to one winner, once.

**`Config`** — `target_n` = 600, `prizes_total` = 6, `p_max` = 0.10, `min_duration_sec` = 25

Keeping these in a tab means you can tune the campaign live without redeploying.

---

## 4. The adaptive drop rate

### Why flat 1% fails

At n=600, p=0.01 the number of winners is Binomial(600, 0.01). Expected 6 — but:

| Outcome | Probability |
|---|---|
| Nobody wins at all | 0.2% |
| ≤3 winners (you're stuck with 3+ unused pins) | **15.0%** |
| ≤5 winners (leftovers) | **44.5%** |
| ≥7 winners (**you run out and owe money you don't have**) | **39.4%** |
| ≥10 winners | 8.3% |

95% range: **2 to 11 winners.** SD = 2.44. A 39% chance of promising a prize you can't pay is not an acceptable risk on a student budget.

### The formula

Recompute on every spin:

```
p = prizes_remaining / max(1, target_n − spins_so_far)
p = min(p, p_max)          // p_max = 0.10
```

- Spin #1: 6/600 = **1.00%** — exactly what you advertise.
- Spin #300, 3 pins gone: 3/300 = **1.00%** — self-correcting, stays honest.
- Spin #300, 0 pins gone: 3/300... 6/300 = **2.00%** — quietly catches up.
- Prizes exhausted: p = 0. Wheel still spins, always lands on "no prize."

Without the clamp this distributes exactly 6 prizes with probability 1, and every participant has an identical unconditional 1% chance regardless of when they answer — mathematically equivalent to secretly pre-assigning 6 winning slots among the 600. The clamp exists to stop a pathological tail (if only 60 people respond, the last person would otherwise face `6/1` = certain win).

**What the clamp actually costs** — 20,000 simulated campaigns of 600 spins:

| `p_max` | All 6 given out | Mean pins used | Odds for the last responder |
|---|---|---|---|
| 0.10 | 96.2% | 5.96 | 0.5% |
| 0.25 | 98.7% | 5.99 | 0.5% |
| 0.50 | 99.6% | 6.00 | 0.9% |
| none | 100% | 6.00 | 1.0% |

`p_max = 0.10` is the right pick: 96% of the time everything goes out through the wheel, and the ~4% tail is exactly what the leftover raffle is for. Raising the clamp buys little and makes late-joiner odds look suspicious if anyone audits the `Spins` log.

### Leftover handling

If you close at 600 with pins unclaimed (possible because of the clamp, or if you fall short of 600 responses), run a raffle among all non-winning respondents and email them. State this in the rules from day one — it's the honest version and it costs you nothing.

### Non-negotiable: the server decides

The wheel animation is **decoration**. The flow is:

1. Client clicks Spin.
2. Server takes the lock, computes `p`, draws a CSPRNG value, decides, claims the pin row, releases the lock, returns the result.
3. Client animates the wheel to land on the answer it was already given.

Never ship the drop rate or the pin codes to the browser. Anyone with DevTools would drain all 6 in a minute.

---

## 5. Anti-fraud

**Identity**
- Google Identity Services with `hd: "kmitl.ac.th"`. Treat that as a UI hint only — **re-verify server-side** that the decoded ID token has `hd === "kmitl.ac.th"`, `email_verified === true`, correct `aud`, and unexpired `exp`.
- Uniqueness key is the `sub` claim. Emails can be aliased (`first.last` vs `firstlast`, `+tag`); `sub` cannot.

**One survey, one spin**
- Before insert: check `user_id` not already in `Responses`. Before spin: check not already in `Spins`. Both inside the lock.
- Survey and spin get separate single-use tokens. A spin token is only issued after a response is successfully written, and is burned on use — kills replay.

**Timer (also your data-quality metric)**
- `t_start` is stamped **server-side** when the survey is served and baked into the signed session token. The on-screen countdown is cosmetic.
- `duration_sec = t_submit − t_start`, both server clocks. Client can't touch it.
- Under `min_duration_sec` (25s for 6 choice questions) → flag `TOO_FAST`. Recommend flagging, not blocking — you can filter in analysis, and a hard block just teaches bots to wait.

**Quality flags**
- `STRAIGHTLINE`: identical option index across all choice questions.
- `IP_CLUSTER`: >5 submissions from one `ip_hash`. Expect false positives on campus NAT and dorm wifi — flag only, never block.

**Plumbing**
- Rate limit per `ip_hash` (e.g. 10 requests/min) via Apps Script `CacheService`.
- reCAPTCHA v3 on submit. Cheap insurance, but honestly the domain-locked OAuth is doing 95% of the work here.

**Legal (Thailand PDPA)** — you're collecting emails tied to survey answers, which is personal data. Add a one-line consent checkbox on the landing screen: what you collect, why, how long you keep it, and that they can request deletion. Also publish the prize rules (6 pins, ~1% odds, one entry per person, leftover raffle) before launch. This takes 20 minutes and removes any argument later.

---

## 6. User flow

1. **Landing** — what the survey is, how long (~2 min), the prize, the odds, PDPA consent checkbox. → "Sign in with KMITL account"
2. **Auth** — Google popup, domain-restricted. Already-submitted users get bounced here with "You've already entered."
3. **Survey** — 6 questions, one screen (6 questions doesn't need pagination), progress bar, unobtrusive elapsed timer.
4. **Submit** — spinner, row written to Sheets.
5. **Spin** — the wheel. Big segment "Try again", small segment "PIN!". One spin, button disables on click.
6. **Result** — Win: the code in large monospace, copy button, "screenshot this now", plus emailed as backup via `MailApp`. Lose: thanks + "X pins still unclaimed, tell your friends" (mild viral push).

**Design notes:** it must feel fast on mobile — most people will open this from a LINE or Discord link on their phone. Make the wheel satisfying (ease-out, ~3s, a click sound); the perceived value of the incentive is mostly in that animation. And put a live "**4 of 6 pins remaining**" counter on the landing page — scarcity drives completion harder than the odds do.

---

## 7. Build checklist

**Setup**
- [ ] Create spreadsheet, 4 tabs, headers, protect `Prizes`
- [ ] Buy/generate the 6 pin codes, paste into `Prizes`, status AVAILABLE
- [ ] Google Cloud project → OAuth client ID → authorized origins
- [ ] Export the 6 questions from the existing form to `questions.json`

**Backend (Apps Script, bound to the sheet)**
- [ ] `verifyIdToken_()` — signature, `aud`, `exp`, `hd`, `email_verified`
- [ ] `doPost` route `startSurvey` → issue signed session token with `t_start`
- [ ] `doPost` route `submitSurvey` → validate, dedupe, flag, append, issue spin token
- [ ] `doPost` route `spin` → **lock** → dedupe → compute `p` → CSPRNG roll → claim pin → log → **unlock**
- [ ] `MailApp` winner email
- [ ] Deploy as web app, "Execute as: me", "Access: anyone"

**Frontend**
- [ ] Landing + consent + live pin counter
- [ ] GIS sign-in button
- [ ] Question renderer from `questions.json`
- [ ] Spin wheel (canvas or CSS transform), lands on server result
- [ ] Result screen, mobile-first

**Test before launch**
- [ ] Non-KMITL Google account → rejected
- [ ] Same account twice → rejected at survey and at spin
- [ ] Force `p = 1.0` in Config → 6 wins drain the pool, 7th gets nothing, no duplicate codes
- [ ] Fire 20 simultaneous spins (Apps Script loop or `curl` in parallel) → never two claims of one pin
- [ ] Tamper with the client (edit `p` in DevTools, replay the spin request) → server rejects
- [ ] Submit in 5 seconds → `TOO_FAST` flag appears
- [ ] Full run on an actual phone

**Launch**
- [ ] Publish prize rules page
- [ ] Distribute link
- [ ] Monitor flag rate daily
- [ ] At 600 or at deadline: freeze, raffle any leftovers, export for analysis

---

## 8. Timeline

| Phase | Effort |
|---|---|
| Sheet + Cloud project + pin codes | 1 h |
| Apps Script backend | 4–6 h |
| Frontend + wheel | 5–8 h |
| Testing (do not compress this) | 3 h |
| Rules + PDPA copy | 1 h |
| **Total** | **~2–3 focused days** |

---

## 9. Two risks worth naming

**The spinner might not be the bottleneck.** A 1% shot at one of 6 pins has an expected value of roughly a few baht per person. What actually drives response rates in a student population is *guaranteed small* over *rare large* — and social proof. If completion is slow in week one, consider: everyone who completes gets entered into a second guaranteed draw, or partner with a faculty/club so the ask comes from a person rather than a link. The spinner's real value is that it's **fun and immediate**, not that it's lucrative. Lean the copy on that.

**Fixed 600 in the denominator.** If you only get 400 responses, the adaptive formula never fully catches up and pins go to the leftover raffle. That's fine and by design — just don't set `target_n` optimistically high. If you'd rather guarantee all 6 go out via the wheel itself, set `target_n` to your *realistic* expectation (say 450) and let the clamp handle any overshoot.

---

## Sources

- [Google Forms API reference](https://developers.google.com/workspace/forms/api/reference/rest) — responses are read-only
- [Feature request: submitting responses via Forms API](https://issuetracker.google.com/issues/277822266) — still open
- [Apps Script LockService](https://developers.google.com/apps-script/reference/lock/lock-service) — `getScriptLock()` for atomic prize claims
- [API changes to Google Forms](https://developers.google.com/workspace/forms/api/guides/api-changes-to-google-forms) — forms created via API after 30 Jun 2026 start unpublished
