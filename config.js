// Fill these two in after you deploy. Nothing secret lives here — the client ID
// and the web app URL are both public by design.
window.APP_CONFIG = {
  // Apps Script → Deploy → New deployment → Web app → copy the /exec URL
  BACKEND_URL: 'https://script.google.com/macros/s/REPLACE_WITH_DEPLOYMENT_ID/exec',

  // Google Cloud Console → Credentials → OAuth 2.0 Client ID (Web application)
  GOOGLE_CLIENT_ID: 'REPLACE_WITH_CLIENT_ID.apps.googleusercontent.com',

  // UI hint only. The backend re-verifies this independently.
  HOSTED_DOMAIN: 'kmitl.ac.th'
};
