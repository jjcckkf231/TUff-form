'use strict';

/**
 * KMITL Survey + Spinner Reward — frontend
 *
 * All trust-sensitive decisions (identity, timer, drop rate, prize codes)
 * happen on the Apps Script backend. This file only renders questions.json,
 * collects answers, and plays an animation that lands on whatever result the
 * server already decided. See backend/Code.gs for the actual logic.
 */

var CFG = window.APP_CONFIG;
var QUESTIONS = null;          // loaded from questions.json
var sessionToken = null;       // survey session, from startSurvey
var spinToken = null;          // single-use spin token, from submitSurvey
var timerHandle = null;
var startedAtLocal = null;

// Affiliate link: https://.../?ref=partnername — validated and attributed
// server-side, this is just carried along with the sign-in request.
var affiliateRef = new URLSearchParams(location.search).get('ref') || '';

// ---------------------------------------------------------------- utilities

function $(id) { return document.getElementById(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function (el) { el.classList.remove('is-active'); });
  $(id).classList.add('is-active');
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function showOverlay(on) { $('overlay').hidden = !on; }

function showError(elId, message) {
  var el = $(elId);
  el.textContent = message;
  el.hidden = false;
}

function hideError(elId) { $(elId).hidden = true; }

function friendlyError(code) {
  var map = {
    NOT_ALLOWED_DOMAIN: 'ต้องเข้าสู่ระบบด้วยบัญชี @kmitl.ac.th หรือ @student.chula.ac.th เท่านั้น',
    EMAIL_NOT_VERIFIED: 'บัญชีนี้ยังไม่ได้ยืนยันอีเมล',
    WRONG_AUDIENCE: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ กรุณาลองใหม่',
    TOKEN_EXPIRED: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
    ALREADY_SUBMITTED: 'คุณเคยตอบแบบสำรวจนี้ไปแล้ว',
    ALREADY_SPUN: 'คุณเคยหมุนวงล้อไปแล้ว',
    CAMPAIGN_CLOSED: 'ขณะนี้ปิดรับคำตอบแล้ว ขอบคุณที่ให้ความสนใจ',
    RATE_LIMITED: 'มีการเข้าใช้งานถี่เกินไป กรุณารอสักครู่',
    BUSY: 'ระบบกำลังทำงานหนัก กรุณาลองใหม่อีกครั้ง',
    MISSING_ANSWER: 'กรุณาตอบให้ครบทุกข้อ',
    NO_RESPONSE: 'ไม่พบคำตอบของคุณ กรุณาทำแบบสำรวจใหม่',
    TOKEN_ALREADY_USED: 'ลิงก์นี้ถูกใช้ไปแล้ว',
    SERVER_ERROR: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ กรุณาลองใหม่'
  };
  return map[code] || 'เกิดข้อผิดพลาด (' + code + ') กรุณาลองใหม่อีกครั้ง';
}

async function callBackend(action, payload) {
  var body = Object.assign({ action: action }, payload || {});
  var res = await fetch(CFG.BACKEND_URL, {
    method: 'POST',
    // text/plain avoids a CORS preflight — Apps Script web apps can't answer OPTIONS.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('HTTP_' + res.status);
  return res.json();
}

// ---------------------------------------------------------------- boot

document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  wireConsent();
  loadStatus();
  await loadQuestions();
  initGoogleSignIn();
}

function wireConsent() {
  var box = $('consent-box');
  var slot = $('signin-slot');
  function sync() {
    slot.classList.toggle('is-disabled', !box.checked);
    $('signin-hint').hidden = box.checked;
  }
  box.addEventListener('change', sync);
  sync();
}

async function loadStatus() {
  try {
    var s = await callBackend('status', {});
    if (s.ok) {
      $('pin-counter').textContent = s.prizes_remaining + ' / ' + s.prizes_total + ' รหัสรางวัลเหลืออยู่';
      if (String(s.campaign_open).toUpperCase() !== 'TRUE') {
        showError('landing-error', friendlyError('CAMPAIGN_CLOSED'));
        $('signin-slot').classList.add('is-disabled');
      }
    } else {
      $('pin-counter').textContent = '1% โอกาสรับรางวัล';
    }
  } catch (e) {
    $('pin-counter').textContent = '1% โอกาสรับรางวัล';
  }
}

async function loadQuestions() {
  var res = await fetch('questions.json');
  QUESTIONS = await res.json();
  $('landing-title').textContent = QUESTIONS.title;
  $('landing-purpose').textContent = QUESTIONS.purpose;
  $('progress-label').textContent = '0 / ' + QUESTIONS.questions.length;
  renderQuestions();
}

// ---------------------------------------------------------------- Google Sign-In

function initGoogleSignIn() {
  if (!window.google || !google.accounts) {
    // gsi script not ready yet — retry shortly
    setTimeout(initGoogleSignIn, 200);
    return;
  }
  google.accounts.id.initialize({
    client_id: CFG.GOOGLE_CLIENT_ID,
    // No hd hint: the backend enforces the allowed-domain list (kmitl.ac.th,
    // student.chula.ac.th for testing), so the account picker stays open to all.
    callback: onGoogleCredential
  });
  google.accounts.id.renderButton($('signin-slot'), {
    type: 'standard',
    theme: 'filled_black',
    size: 'large',
    text: 'signin_with',
    shape: 'pill',
    width: 280
  });
}

async function onGoogleCredential(response) {
  if (!$('consent-box').checked) return;
  hideError('landing-error');
  showOverlay(true);
  try {
    var res = await callBackend('startSurvey', { id_token: response.credential, ref: affiliateRef });
    if (!res.ok) {
      if (res.error === 'ALREADY_SUBMITTED') {
        showAlreadyDone(res);
      } else {
        showError('landing-error', friendlyError(res.error));
      }
      return;
    }
    sessionToken = res.session_token;
    startedAtLocal = Date.now();
    showScreen('screen-survey');
    startTimer();
  } catch (e) {
    showError('landing-error', 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่');
  } finally {
    showOverlay(false);
  }
}

function showAlreadyDone(res) {
  showScreen('screen-result');
  $('result-win').hidden = true;
  $('result-lose').hidden = true;
  $('result-done').hidden = false;
  $('done-detail').textContent = res.already_spun
    ? (res.spin_result === 'WIN' ? 'คุณเคยได้รับรางวัลไปแล้ว ตรวจสอบอีเมลของคุณ' : 'คุณเคยหมุนวงล้อไปแล้ว ขอบคุณที่ร่วมตอบแบบสำรวจ')
    : 'ระบบกำลังประมวลผลคำตอบก่อนหน้าของคุณ กรุณาลองใหม่ภายหลัง';
}

// ---------------------------------------------------------------- survey render

function renderQuestions() {
  var container = $('questions');
  container.innerHTML = '';

  QUESTIONS.questions.forEach(function (q, qi) {
    var block = document.createElement('div');
    block.className = 'q-block';
    block.dataset.qid = q.id;

    var label = document.createElement('div');
    label.className = 'q-text';
    label.textContent = (qi + 1) + '. ' + q.text;
    if (q.required) {
      var star = document.createElement('span');
      star.className = 'q-required';
      star.textContent = '*';
      label.appendChild(star);
    }
    block.appendChild(label);

    var opts = document.createElement('div');
    opts.className = 'options';

    q.options.forEach(function (optText, oi) {
      var row = document.createElement('label');
      row.className = 'option';

      var input = document.createElement('input');
      input.type = 'radio';
      input.name = q.id;
      input.value = optText;
      input.dataset.index = oi;

      var span = document.createElement('span');
      span.textContent = optText;

      row.appendChild(input);
      row.appendChild(span);
      opts.appendChild(row);

      input.addEventListener('change', function () {
        opts.querySelectorAll('.option').forEach(function (o) { o.classList.remove('is-checked'); });
        row.classList.add('is-checked');
        var isOther = q.has_other_free_text && oi === q.options.length - 1;
        var otherInput = block.querySelector('.other-text');
        if (otherInput) otherInput.classList.toggle('is-visible', isOther);
        updateProgress();
      });
    });

    block.appendChild(opts);

    if (q.has_other_free_text) {
      var otherInput = document.createElement('input');
      otherInput.type = 'text';
      otherInput.className = 'other-text';
      otherInput.placeholder = 'โปรดระบุ...';
      otherInput.maxLength = 120;
      block.appendChild(otherInput);
    }

    container.appendChild(block);
  });

  $('survey-form').addEventListener('submit', onSubmitSurvey);
}

function collectAnswers() {
  var answers = {};
  var indexes = {};
  var complete = true;

  QUESTIONS.questions.forEach(function (q) {
    var checked = document.querySelector('input[name="' + q.id + '"]:checked');
    if (!checked) { complete = false; return; }

    var oi = Number(checked.dataset.index);
    var value = checked.value;

    if (q.has_other_free_text && oi === q.options.length - 1) {
      var block = document.querySelector('.q-block[data-qid="' + q.id + '"]');
      var otherText = block.querySelector('.other-text').value.trim();
      if (otherText) value = value + ': ' + otherText;
    }

    answers[q.id] = value;
    indexes[q.id] = oi;
  });

  return { answers: answers, indexes: indexes, complete: complete };
}

function updateProgress() {
  var result = collectAnswers();
  var answered = Object.keys(result.answers).length;
  var total = QUESTIONS.questions.length;
  $('progress-label').textContent = answered + ' / ' + total;
  $('progress-fill').style.width = (answered / total * 100) + '%';
  $('submit-btn').disabled = !result.complete;
}

function startTimer() {
  var elapsedEl = $('timer');
  timerHandle = setInterval(function () {
    var s = Math.floor((Date.now() - startedAtLocal) / 1000);
    var m = Math.floor(s / 60);
    var ss = String(s % 60).padStart(2, '0');
    elapsedEl.textContent = m + ':' + ss;
  }, 500);
}

function stopTimer() { if (timerHandle) clearInterval(timerHandle); }

// ---------------------------------------------------------------- submit

async function onSubmitSurvey(e) {
  e.preventDefault();
  hideError('survey-error');

  var result = collectAnswers();
  if (!result.complete) {
    showError('survey-error', friendlyError('MISSING_ANSWER'));
    return;
  }

  $('submit-btn').disabled = true;
  showOverlay(true);
  try {
    var res = await callBackend('submitSurvey', {
      session_token: sessionToken,
      answers: result.answers,
      answer_indexes: result.indexes
    });
    if (!res.ok) {
      showError('survey-error', friendlyError(res.error));
      $('submit-btn').disabled = false;
      return;
    }
    stopTimer();
    spinToken = res.spin_token;
    showScreen('screen-spin');
    setupWheel();
  } catch (e2) {
    showError('survey-error', 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่');
    $('submit-btn').disabled = false;
  } finally {
    showOverlay(false);
  }
}

// ---------------------------------------------------------------- wheel

// Cosmetic only. 8 alternating segments; server result decides which segment
// class ("prize" or "blank") the wheel eases to a stop on.
var WHEEL_SEGMENTS = [
  { label: 'PIN!', kind: 'prize' },
  { label: 'ลองใหม่', kind: 'blank' },
  { label: 'ลองใหม่', kind: 'blank' },
  { label: 'ลองใหม่', kind: 'blank' },
  { label: 'PIN!', kind: 'prize' },
  { label: 'ลองใหม่', kind: 'blank' },
  { label: 'ลองใหม่', kind: 'blank' },
  { label: 'ลองใหม่', kind: 'blank' }
];

function setupWheel() {
  drawWheel();
  var btn = $('spin-btn');
  btn.disabled = false;
  btn.textContent = 'หมุน!';
  btn.onclick = onSpin;
}

function drawWheel() {
  var canvas = $('wheel');
  var ctx = canvas.getContext('2d');
  var n = WHEEL_SEGMENTS.length;
  var r = canvas.width / 2;
  var arc = (2 * Math.PI) / n;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  WHEEL_SEGMENTS.forEach(function (seg, i) {
    var start = i * arc - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(r, r);
    ctx.arc(r, r, r, start, start + arc);
    ctx.closePath();
    ctx.fillStyle = seg.kind === 'prize'
      ? (i % 2 === 0 ? '#ffb020' : '#ff9500')
      : (i % 2 === 0 ? '#1f232c' : '#262b35');
    ctx.fill();
    ctx.strokeStyle = '#0f1115';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.translate(r, r);
    ctx.rotate(start + arc / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = seg.kind === 'prize' ? '#1a1200' : '#c9cdd6';
    ctx.font = 'bold ' + Math.round(r * 0.09) + 'px "IBM Plex Sans Thai", sans-serif';
    ctx.fillText(seg.label, r - 24, 8);
    ctx.restore();
  });
}

var currentRotation = 0;
var preSpinTimer = null;

// Spins the wheel continuously at a fixed rate so the click feels instant,
// while the real result is still in flight (spin involves a server-side
// lock + sheet read/write and can take a couple of seconds).
function startPreSpin() {
  var canvas = $('wheel');
  canvas.style.transitionDuration = '0.45s';
  canvas.style.transitionTimingFunction = 'linear';
  function tick() {
    currentRotation += 170;
    canvas.style.transform = 'rotate(' + currentRotation + 'deg)';
  }
  tick();
  preSpinTimer = setInterval(tick, 450);
}

function stopPreSpin() {
  if (preSpinTimer) { clearInterval(preSpinTimer); preSpinTimer = null; }
}

async function onSpin() {
  var btn = $('spin-btn');
  btn.disabled = true;
  btn.textContent = 'กำลังหมุน...';
  hideError('spin-error');
  startPreSpin();

  var res;
  try {
    res = await callBackend('spin', { spin_token: spinToken });
  } catch (e) {
    stopPreSpin();
    showError('spin-error', 'เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่');
    btn.disabled = false;
    btn.textContent = 'หมุน!';
    return;
  }

  if (!res.ok) {
    stopPreSpin();
    showError('spin-error', friendlyError(res.error));
    if (res.error === 'ALREADY_SPUN') {
      setTimeout(function () { showScreen('screen-result'); showResult({ result: null }); }, 800);
    } else {
      btn.disabled = false;
      btn.textContent = 'หมุน!';
    }
    return;
  }

  stopPreSpin();
  animateWheelTo(res.result === 'WIN', function () {
    showResult(res);
  });
}

function animateWheelTo(isWin, done) {
  var canvas = $('wheel');
  var n = WHEEL_SEGMENTS.length;
  var arc = 360 / n;

  var candidateIndexes = [];
  WHEEL_SEGMENTS.forEach(function (seg, i) { if ((seg.kind === 'prize') === isWin) candidateIndexes.push(i); });
  var targetIndex = candidateIndexes[Math.floor(Math.random() * candidateIndexes.length)];

  // Segment i is centered at (i * arc), pointer is fixed at top (0deg).
  // Land the wheel so that segment's center sits at the pointer, plus jitter.
  var targetCenter = targetIndex * arc;
  var jitter = (Math.random() - 0.5) * arc * 0.6;
  var extraSpins = 5 * 360;

  // Continue smoothly from wherever the pre-spin loop left the wheel,
  // rather than restarting from a fixed baseline.
  var currentMod = ((currentRotation % 360) + 360) % 360;
  var targetMod = (((360 - targetCenter) + jitter) % 360 + 360) % 360;
  var deltaToTarget = ((targetMod - currentMod) % 360 + 360) % 360;
  var finalRotation = currentRotation + extraSpins + deltaToTarget;

  currentRotation = finalRotation;
  canvas.style.transitionDuration = '3s';
  canvas.style.transitionTimingFunction = 'cubic-bezier(.15,.85,.25,1)';
  canvas.style.transform = 'rotate(' + finalRotation + 'deg)';

  setTimeout(done, 3100);
}

// ---------------------------------------------------------------- result

function showResult(res) {
  showScreen('screen-result');
  $('result-win').hidden = true;
  $('result-lose').hidden = true;
  $('result-done').hidden = true;

  if (res.result === 'WIN') {
    $('result-win').hidden = false;
    $('prize-code').textContent = res.code;
    $('copy-btn').onclick = function () {
      navigator.clipboard.writeText(res.code).then(function () {
        $('copy-btn').textContent = 'คัดลอกแล้ว ✓';
        setTimeout(function () { $('copy-btn').textContent = 'คัดลอกรหัส'; }, 1500);
      });
    };
  } else if (res.result === 'LOSE') {
    $('result-lose').hidden = false;
    var remaining = res.prizes_remaining;
    $('lose-remaining').textContent = typeof remaining === 'number'
      ? 'ยังเหลือรหัสรางวัลอีก ' + remaining + ' รหัส ชวนเพื่อนมาตอบกันเถอะ!'
      : '';
    $('share-btn').onclick = function () {
      if (navigator.share) {
        navigator.share({ title: document.title, url: location.href }).catch(function () {});
      } else {
        navigator.clipboard.writeText(location.href);
        $('share-btn').textContent = 'คัดลอกลิงก์แล้ว ✓';
      }
    };
  } else {
    $('result-done').hidden = false;
    $('done-detail').textContent = 'ขอบคุณที่ร่วมตอบแบบสำรวจ';
  }
}
