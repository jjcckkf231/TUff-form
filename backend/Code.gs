/**
 * KMITL Survey + Spinner Reward — Apps Script backend
 * Standalone script — set SHEET_ID below to the target spreadsheet's ID
 * (from its URL: https://docs.google.com/spreadsheets/d/SHEET_ID/edit).
 *
 * One-time setup:
 *   1. Run setupSheet()      — creates the 4 tabs + headers + protects Prizes
 *   2. Run setupSecrets()    — generates the HMAC signing secret
 *   3. Set OAUTH_CLIENT_ID in Script Properties (Project Settings → Script Properties)
 *   4. Paste your 6 pin codes into the Prizes tab (status AVAILABLE)
 *   5. Deploy → New deployment → Web app → Execute as: Me, Access: Anyone
 */

// ---------------------------------------------------------------- constants

var SHEET_ID = '1RmfgFruw9t7cV67LbxDhyvuVepSTU_aH1XPNdFcRlxc';

function ss_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

var TAB_RESPONSES = 'Responses';
var TAB_SPINS     = 'Spins';
var TAB_PRIZES    = 'Prizes';
var TAB_CONFIG    = 'Config';

var RESPONSE_HEADERS = [
  'response_id', 'user_id', 'email', 'started_at', 'submitted_at', 'duration_sec',
  'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'ip_hash', 'flags'
];
var SPIN_HEADERS   = ['spin_id', 'user_id', 'spun_at', 'p_used', 'roll', 'result', 'prize_id'];
var PRIZE_HEADERS  = ['prize_id', 'code', 'status', 'claimed_by', 'claimed_at'];
var CONFIG_HEADERS = ['key', 'value'];

var CONFIG_DEFAULTS = [
  ['target_n', 600],
  ['prizes_total', 6],
  ['p_max', 0.10],
  ['min_duration_sec', 30],
  ['campaign_open', 'TRUE']
];

// student.chula.ac.th added alongside kmitl.ac.th for testing.
var ALLOWED_HOSTED_DOMAINS = ['kmitl.ac.th', 'student.chula.ac.th'];

var QUESTION_IDS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'];
var CHOICE_QUESTION_IDS = QUESTION_IDS; // all 8 are single_choice
var SESSION_TTL_SEC = 60 * 60;          // survey session valid 1 hour
var SPIN_TTL_SEC    = 30 * 60;          // spin token valid 30 minutes

// ---------------------------------------------------------------- entrypoints

/**
 * All traffic is POST with Content-Type: text/plain so the browser skips the
 * CORS preflight (Apps Script web apps cannot answer OPTIONS).
 */
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'BAD_REQUEST' });
  }

  try {
    switch (body.action) {
      case 'status':       return json_(handleStatus_());
      case 'startSurvey':  return json_(handleStartSurvey_(body));
      case 'submitSurvey': return json_(handleSubmitSurvey_(body));
      case 'spin':         return json_(handleSpin_(body));
      default:             return json_({ ok: false, error: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    console.error(err.stack || err);
    return json_({ ok: false, error: 'SERVER_ERROR', detail: String(err && err.message || err) });
  }
}

/** GET is only used for the public scarcity counter on the landing page. */
function doGet() {
  return json_(handleStatus_());
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- routes

/** Public, unauthenticated. Powers "X of 6 pins remaining". */
function handleStatus_() {
  var cfg = getConfig_();
  var prizes = readTab_(TAB_PRIZES);
  var remaining = prizes.filter(function (r) { return String(r.status).toUpperCase() === 'AVAILABLE'; }).length;
  return {
    ok: true,
    prizes_total: prizes.length,
    prizes_remaining: remaining,
    responses_count: countRows_(TAB_RESPONSES),
    target_n: cfg.target_n,
    campaign_open: cfg.campaign_open
  };
}

/**
 * Verifies the Google ID token, checks the user hasn't already entered, and
 * issues a signed session token carrying a SERVER-side t_start.
 */
function handleStartSurvey_(body) {
  var claims = verifyIdToken_(body.id_token);
  if (!claims.ok) return { ok: false, error: claims.error };

  var cfg = getConfig_();
  if (String(cfg.campaign_open).toUpperCase() !== 'TRUE') {
    return { ok: false, error: 'CAMPAIGN_CLOSED' };
  }

  if (!rateLimit_('start:' + claims.sub, 10, 60)) {
    return { ok: false, error: 'RATE_LIMITED' };
  }

  var existing = findRow_(TAB_RESPONSES, 'user_id', claims.sub);
  if (existing) {
    var spun = findRow_(TAB_SPINS, 'user_id', claims.sub);
    return {
      ok: false,
      error: 'ALREADY_SUBMITTED',
      already_spun: !!spun,
      spin_result: spun ? spun.result : null
    };
  }

  var now = new Date();
  var token = signToken_({
    kind: 'session',
    sub: claims.sub,
    email: claims.email,
    t_start: now.getTime(),
    jti: Utilities.getUuid(),
    exp: now.getTime() + SESSION_TTL_SEC * 1000
  });

  return { ok: true, session_token: token, email: claims.email, min_duration_sec: cfg.min_duration_sec };
}

/**
 * Validates the session token, dedupes, computes duration + quality flags
 * server-side, appends the row, and issues a single-use spin token.
 */
function handleSubmitSurvey_(body) {
  var t = verifyToken_(body.session_token, 'session');
  if (!t.ok) return { ok: false, error: t.error };

  var answers = body.answers || {};
  for (var i = 0; i < QUESTION_IDS.length; i++) {
    var qid = QUESTION_IDS[i];
    if (!answers[qid] || String(answers[qid]).trim() === '') {
      return { ok: false, error: 'MISSING_ANSWER', question: qid };
    }
  }

  var cfg = getConfig_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'BUSY' };

  try {
    if (findRow_(TAB_RESPONSES, 'user_id', t.payload.sub)) {
      return { ok: false, error: 'ALREADY_SUBMITTED' };
    }

    var submittedAt = new Date();
    var startedAt = new Date(t.payload.t_start);
    var durationSec = Math.round((submittedAt.getTime() - startedAt.getTime()) / 1000);

    var flags = [];
    if (durationSec < Number(cfg.min_duration_sec)) flags.push('TOO_FAST');
    if (isStraightline_(answers, body.answer_indexes)) flags.push('STRAIGHTLINE');

    var row = [
      Utilities.getUuid(),
      t.payload.sub,
      t.payload.email,
      startedAt.toISOString(),
      submittedAt.toISOString(),
      durationSec
    ];
    for (var j = 0; j < QUESTION_IDS.length; j++) row.push(String(answers[QUESTION_IDS[j]]));
    row.push('');                 // ip_hash — see SETUP.md, Apps Script cannot see client IP
    row.push(flags.join(','));

    sheet_(TAB_RESPONSES).appendRow(row);
  } finally {
    lock.releaseLock();
  }

  var now = new Date();
  var spinToken = signToken_({
    kind: 'spin',
    sub: t.payload.sub,
    email: t.payload.email,
    jti: Utilities.getUuid(),
    exp: now.getTime() + SPIN_TTL_SEC * 1000
  });

  return { ok: true, spin_token: spinToken, duration_sec: Math.round((now - new Date(t.payload.t_start)) / 1000) };
}

/**
 * THE atomic section. Lock → dedupe → compute p → CSPRNG roll → claim pin →
 * log → unlock. Nothing about the odds or the codes ever reaches the client
 * except the single code the single winner earned.
 */
function handleSpin_(body) {
  var t = verifyToken_(body.spin_token, 'spin');
  if (!t.ok) return { ok: false, error: t.error };

  var cache = CacheService.getScriptCache();
  if (cache.get('burned:' + t.payload.jti)) return { ok: false, error: 'TOKEN_ALREADY_USED' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'BUSY' };

  try {
    if (cache.get('burned:' + t.payload.jti)) return { ok: false, error: 'TOKEN_ALREADY_USED' };
    if (findRow_(TAB_SPINS, 'user_id', t.payload.sub)) return { ok: false, error: 'ALREADY_SPUN' };
    if (!findRow_(TAB_RESPONSES, 'user_id', t.payload.sub)) return { ok: false, error: 'NO_RESPONSE' };

    var cfg = getConfig_();
    var prizesSheet = sheet_(TAB_PRIZES);
    var prizes = readTab_(TAB_PRIZES);
    var availableIdx = -1;
    var remaining = 0;
    for (var i = 0; i < prizes.length; i++) {
      if (String(prizes[i].status).toUpperCase() === 'AVAILABLE') {
        remaining++;
        if (availableIdx === -1) availableIdx = i;
      }
    }

    var spinsSoFar = countRows_(TAB_SPINS);

    // p = prizes_remaining / max(1, target_n − spins_so_far), clamped at p_max
    var p = remaining / Math.max(1, Number(cfg.target_n) - spinsSoFar);
    p = Math.min(p, Number(cfg.p_max));
    if (remaining === 0) p = 0;

    var roll = secureRandom_();
    var won = roll < p;

    var prizeId = '';
    var code = null;

    if (won && availableIdx !== -1) {
      var rowNumber = availableIdx + 2; // +1 header, +1 to 1-index
      prizeId = prizes[availableIdx].prize_id;
      code = String(prizes[availableIdx].code);
      prizesSheet.getRange(rowNumber, PRIZE_HEADERS.indexOf('status') + 1).setValue('CLAIMED');
      prizesSheet.getRange(rowNumber, PRIZE_HEADERS.indexOf('claimed_by') + 1).setValue(t.payload.sub);
      prizesSheet.getRange(rowNumber, PRIZE_HEADERS.indexOf('claimed_at') + 1).setValue(new Date().toISOString());
      SpreadsheetApp.flush();
    } else {
      won = false;
    }

    sheet_(TAB_SPINS).appendRow([
      Utilities.getUuid(),
      t.payload.sub,
      new Date().toISOString(),
      p,
      roll,
      won ? 'WIN' : 'LOSE',
      prizeId
    ]);
    SpreadsheetApp.flush();

    cache.put('burned:' + t.payload.jti, '1', 21600); // 6h, outlives the token

    if (won) {
      try { mailWinner_(t.payload.email, code); } catch (mailErr) { console.error(mailErr); }
    }

    return {
      ok: true,
      result: won ? 'WIN' : 'LOSE',
      code: won ? code : null,
      prizes_remaining: won ? remaining - 1 : remaining
    };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- identity

/**
 * Server-side ID token verification. Uses Google's tokeninfo endpoint so we
 * get signature + expiry checking from Google itself, then we re-check every
 * claim we care about ourselves. hd is NOT trusted from the client.
 */
function verifyIdToken_(idToken) {
  if (!idToken) return { ok: false, error: 'NO_TOKEN' };

  var clientId = PropertiesService.getScriptProperties().getProperty('OAUTH_CLIENT_ID');
  if (!clientId) throw new Error('OAUTH_CLIENT_ID not set in Script Properties');

  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) return { ok: false, error: 'INVALID_TOKEN' };

  var c;
  try { c = JSON.parse(res.getContentText()); } catch (e) { return { ok: false, error: 'INVALID_TOKEN' }; }

  if (c.aud !== clientId) return { ok: false, error: 'WRONG_AUDIENCE' };
  if (c.iss !== 'accounts.google.com' && c.iss !== 'https://accounts.google.com') {
    return { ok: false, error: 'WRONG_ISSUER' };
  }
  if (Number(c.exp) * 1000 < Date.now()) return { ok: false, error: 'TOKEN_EXPIRED' };
  if (String(c.email_verified) !== 'true') return { ok: false, error: 'EMAIL_NOT_VERIFIED' };
  if (ALLOWED_HOSTED_DOMAINS.indexOf(c.hd) === -1) return { ok: false, error: 'NOT_ALLOWED_DOMAIN' };
  if (!c.sub) return { ok: false, error: 'INVALID_TOKEN' };

  return { ok: true, sub: c.sub, email: c.email };
}

// ---------------------------------------------------------------- signed tokens

function secret_() {
  var s = PropertiesService.getScriptProperties().getProperty('SIGNING_SECRET');
  if (!s) throw new Error('SIGNING_SECRET not set — run setupSecrets()');
  return s;
}

function signToken_(payload) {
  var body = b64url_(Utilities.newBlob(JSON.stringify(payload)).getBytes());
  var sig = b64url_(Utilities.computeHmacSha256Signature(body, secret_()));
  return body + '.' + sig;
}

function verifyToken_(token, expectedKind) {
  if (!token || token.indexOf('.') === -1) return { ok: false, error: 'NO_TOKEN' };
  var parts = token.split('.');
  var expected = b64url_(Utilities.computeHmacSha256Signature(parts[0], secret_()));
  if (!constantTimeEquals_(expected, parts[1])) return { ok: false, error: 'BAD_SIGNATURE' };

  var payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (e) {
    return { ok: false, error: 'BAD_TOKEN' };
  }

  if (payload.kind !== expectedKind) return { ok: false, error: 'WRONG_TOKEN_KIND' };
  if (Number(payload.exp) < Date.now()) return { ok: false, error: 'TOKEN_EXPIRED' };

  return { ok: true, payload: payload };
}

function b64url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function constantTimeEquals_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Apps Script has no crypto.getRandomValues. Utilities.getUuid() is a RFC-4122
 * v4 UUID backed by java.util.UUID.randomUUID(), which uses a cryptographically
 * strong SecureRandom. We take 13 random hex digits → uniform [0, 1).
 */
function secureRandom_() {
  var hex = Utilities.getUuid().replace(/-/g, '');
  // skip index 12 (the version nibble '4') and 16 (the variant nibble)
  var randomHex = hex.substring(0, 12) + hex.substring(17, 18);
  return parseInt(randomHex, 16) / Math.pow(16, 13);
}

// ---------------------------------------------------------------- quality flags

function isStraightline_(answers, indexes) {
  if (!indexes) return false;
  var first = null;
  for (var i = 0; i < CHOICE_QUESTION_IDS.length; i++) {
    var v = indexes[CHOICE_QUESTION_IDS[i]];
    if (v === undefined || v === null) return false;
    if (first === null) first = v;
    else if (v !== first) return false;
  }
  return true;
}

function rateLimit_(key, maxHits, windowSec) {
  var cache = CacheService.getScriptCache();
  var k = 'rl:' + key;
  var n = Number(cache.get(k) || 0) + 1;
  cache.put(k, String(n), windowSec);
  return n <= maxHits;
}

// ---------------------------------------------------------------- sheet helpers

function sheet_(name) {
  var s = ss_().getSheetByName(name);
  if (!s) throw new Error('Missing tab: ' + name + ' — run setupSheet()');
  return s;
}

function readTab_(name) {
  var values = sheet_(name).getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]).trim() === '') continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = values[r][c];
    out.push(obj);
  }
  return out;
}

function countRows_(name) {
  return Math.max(0, sheet_(name).getLastRow() - 1);
}

function findRow_(name, column, value) {
  var rows = readTab_(name);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][column]) === String(value)) return rows[i];
  }
  return null;
}

function getConfig_() {
  var rows = readTab_(TAB_CONFIG);
  var cfg = {};
  for (var i = 0; i < rows.length; i++) cfg[rows[i].key] = rows[i].value;
  for (var j = 0; j < CONFIG_DEFAULTS.length; j++) {
    if (cfg[CONFIG_DEFAULTS[j][0]] === undefined) cfg[CONFIG_DEFAULTS[j][0]] = CONFIG_DEFAULTS[j][1];
  }
  return cfg;
}

function mailWinner_(email, code) {
  MailApp.sendEmail({
    to: email,
    subject: 'คุณได้รับรางวัลจากแบบสำรวจ KMITL 🎉',
    htmlBody:
      '<p>ขอบคุณที่ร่วมตอบแบบสำรวจ คุณได้รับรางวัล!</p>' +
      '<p>รหัสของคุณ:</p>' +
      '<p style="font-size:24px;font-family:monospace;letter-spacing:2px"><b>' + code + '</b></p>' +
      '<p>กรุณาเก็บรหัสนี้ไว้ หากมีปัญหาในการใช้งานให้ตอบกลับอีเมลฉบับนี้</p>'
  });
}

// ---------------------------------------------------------------- one-time setup

function setupSheet() {
  var ss = ss_();

  ensureTab_(ss, TAB_RESPONSES, RESPONSE_HEADERS);
  ensureTab_(ss, TAB_SPINS, SPIN_HEADERS);
  ensureTab_(ss, TAB_PRIZES, PRIZE_HEADERS);
  var config = ensureTab_(ss, TAB_CONFIG, CONFIG_HEADERS);

  if (config.getLastRow() < 2) config.getRange(2, 1, CONFIG_DEFAULTS.length, 2).setValues(CONFIG_DEFAULTS);

  var prizes = ss.getSheetByName(TAB_PRIZES);
  if (prizes.getLastRow() < 2) {
    var placeholder = [];
    for (var i = 1; i <= 6; i++) placeholder.push(['P' + i, 'REPLACE_ME_' + i, 'AVAILABLE', '', '']);
    prizes.getRange(2, 1, placeholder.length, PRIZE_HEADERS.length).setValues(placeholder);
  }

  var protection = prizes.protect().setDescription('Prize codes — real money. Owner only.');
  protection.removeEditors(protection.getEditors());
  protection.setWarningOnly(false);

  Logger.log('Setup complete. Now paste your real pin codes into Prizes and run setupSecrets().');
}

function ensureTab_(ss, name, headers) {
  var s = ss.getSheetByName(name) || ss.insertSheet(name);
  if (s.getLastRow() === 0) {
    s.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  return s;
}

function setupSecrets() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('SIGNING_SECRET')) {
    props.setProperty('SIGNING_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  console.log('SIGNING_SECRET ready. Now set OAUTH_CLIENT_ID in Project Settings → Script Properties.');
}

/** Raffle any pins left over at close, among non-winning respondents. */
function raffleLeftovers() {
  var prizes = readTab_(TAB_PRIZES).filter(function (p) { return String(p.status).toUpperCase() === 'AVAILABLE'; });
  if (!prizes.length) { console.log('No leftover pins.'); return; }

  var winners = {};
  readTab_(TAB_SPINS).forEach(function (s) { if (s.result === 'WIN') winners[s.user_id] = true; });
  var pool = readTab_(TAB_RESPONSES).filter(function (r) { return !winners[r.user_id]; });

  if (pool.length < prizes.length) { console.log('Pool smaller than prize count — handle manually.'); return; }

  var picked = [];
  var seen = {};
  while (picked.length < prizes.length) {
    var i = Math.floor(secureRandom_() * pool.length);
    if (seen[i]) continue;
    seen[i] = true;
    picked.push(pool[i]);
  }
  console.log('Raffle winners (send codes manually, then mark Prizes CLAIMED):');
  picked.forEach(function (p, i) { console.log(prizes[i].prize_id + ' → ' + p.email); });
}
