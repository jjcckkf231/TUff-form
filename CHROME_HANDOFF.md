# Task for Claude in Chrome: finish deploying the KMITL survey backend

## Context

Project folder (open this in a file explorer / editor alongside the browser):
`c:\Users\Poomp\OneDrive\Desktop\Big Screen Ads\tuff-form`

This is a Google Apps Script + static-HTML survey app for KMITL students, with a
"spin the wheel" prize mechanic (6 cash-pin codes). All code is already written.
What's left is manual configuration through Google's web UIs — Sheets, the Apps
Script editor, and Google Cloud Console — which needs a real signed-in browser
session, so it's being handed to you instead of done via CLI.

Detailed step-by-step instructions already exist in the project at
`SETUP.md`, sections **1 through 4**. Follow those verbatim. This document adds
context and known pitfalls on top.

**Google account to use for all of this:** `poompitaya@gmail.com`. This is the
*owner/deployer* account — it is a normal Gmail account, not a `kmitl.ac.th`
account. `kmitl.ac.th` is only the domain restriction applied later to the
*students* who take the survey; it has nothing to do with which account builds
and deploys the backend.

## Files you'll need (open/read from the project folder)

- `backend\Code.gs` — full backend script. Paste its entire contents verbatim
  into the Apps Script editor (overwrite the default `Code.gs`).
- `backend\appsscript.json` — manifest file. Paste into the Apps Script editor's
  `appsscript.json` view (enable "Show appsscript.json manifest file" first,
  under Project Settings).
- `config.js` — you'll edit this yourself at the very end with two values you
  collect during setup (see step 19 below).

## Steps

1. Go to https://sheets.google.com signed in as `poompitaya@gmail.com`. If
   multiple Google accounts are logged into the browser, explicitly switch to
   this one — account mismatches are the #1 way this setup silently breaks.
2. Create a new blank spreadsheet. Name it something like "KMITL Survey Data".
3. Extensions → Apps Script. This opens a script editor bound to the sheet.
4. Delete the default `Code.gs` content. Open the local file
   `backend\Code.gs`, copy all of it, paste into the editor.
5. Click the gear icon (Project Settings) → check "Show appsscript.json
   manifest file in editor".
6. Back in the editor, open `appsscript.json`, replace its contents with the
   local file `backend\appsscript.json`.
7. In the function dropdown at the top of the editor, select `setupSheet`,
   click Run. Google will show an OAuth consent screen ("Google hasn't
   verified this app") — click **Advanced** → **Go to (project name)
   (unsafe)** → **Allow**. This is expected and safe; it's your own script
   running under your own account.
8. Select `setupSecrets` from the dropdown, Run.
9. Go back to the spreadsheet, open the **Prizes** tab. It will have 6 rows
   with placeholder codes `REPLACE_ME_1`...`REPLACE_ME_6`. **Stop and ask the
   user for the 6 real prize codes** before overwriting these — do not
   invent or leave placeholders in place for a real launch.
10. Go to https://console.cloud.google.com. Apps Script auto-creates a backing
    GCP project — it may already be selected. If prompted to create one,
    name doesn't matter.
11. APIs & Services → OAuth consent screen → **External** → fill in app name
    (e.g. "KMITL Survey"), user support email and developer contact email =
    `poompitaya@gmail.com` → step through and **Publish** the app. A
    small-scale unverified-app warning at sign-in is expected and fine for
    this use case — it is not a blocker.
12. APIs & Services → Credentials → Create Credentials → **OAuth client ID** →
    Application type: **Web application**.
13. Under Authorized JavaScript origins, add the URL the frontend will be
    hosted at (e.g. a GitHub Pages or Vercel URL). **If you don't know this
    yet, ask the user** rather than guessing. Add `http://localhost:5500` too
    if local testing is planned.
14. Create → copy the **Client ID** (`xxxxx.apps.googleusercontent.com`).
15. Back in the Apps Script editor: gear icon → Project Settings → Script
    Properties → Add property `OAUTH_CLIENT_ID` = the value from step 14.
16. Deploy → New deployment → select type **Web app** (gear icon to pick
    type if not shown). Execute as: **Me**. Who has access: **Anyone**.
    Deploy.
17. This triggers another one-time authorization prompt for the web app
    itself — same "Advanced → unsafe → Allow" click-through as step 7.
18. Copy the `/exec` URL shown after deploying — this is `BACKEND_URL`.
19. Open the local file `config.js` and fill in:
    - `BACKEND_URL` = the `/exec` URL from step 18
    - `GOOGLE_CLIENT_ID` = the client ID from step 14
    - leave `HOSTED_DOMAIN: 'kmitl.ac.th'` as-is
20. Report back to the user: the deployment URL, the OAuth client ID, and
    confirmation that the spreadsheet now has 4 tabs (`Responses`, `Spins`,
    `Prizes`, `Config`) with no errors in the Apps Script execution log.

## Known pitfalls (already hit once tonight)

- If anything reports **"User has not enabled the Apps Script API"**, the fix
  is https://script.google.com/home/usersettings → toggle it on, **while
  signed in as the exact same account doing the rest of this work**. This
  matters most for CLI tooling (`clasp`) — clicking through the Apps Script
  editor UI directly, as this guide does, normally doesn't hit it. If it does
  come up, the toggle can take a few minutes to propagate; don't assume it
  failed to save just because the very next click still errors.
- Don't paste the real prize codes into any tool outside the Sheet itself
  (not into this chat, not into a form field, not into a screenshot) — they
  are redeemable cash value.
- `setupSheet` is safe to re-run if unsure whether it already ran — it only
  creates tabs/headers that don't already exist.

## Stop and ask the user if

- You don't have the 6 real prize codes.
- You don't know what URL the frontend will be hosted at.
- The OAuth consent screen requires a privacy policy / terms URL you don't
  have.
