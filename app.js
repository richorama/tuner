/* ============================================================
   NEON TUNER — app logic
   - Web Audio mic capture
   - Autocorrelation pitch detection (with parabolic interpolation)
   - Note / cents calculation
   - Canvas gauge, strobe, history + LED strip + amplitude
   - PWA service worker registration
   ============================================================ */

(() => {
  'use strict';

  // ---------- Music helpers ----------
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // Standard tuning targets (note name + octave). MIDI numbers computed below.
  const INSTRUMENTS = {
    guitar: [
      { name: 'E', octave: 2 }, { name: 'A', octave: 2 }, { name: 'D', octave: 3 },
      { name: 'G', octave: 3 }, { name: 'B', octave: 3 }, { name: 'E', octave: 4 },
    ],
    bass: [
      { name: 'B', octave: 0 }, { name: 'E', octave: 1 }, { name: 'A', octave: 1 },
      { name: 'D', octave: 2 }, { name: 'G', octave: 2 },
    ],
  };

  let a4 = 440;
  let instrument = 'guitar';

  const midiFromName = (name, octave) => NOTE_NAMES.indexOf(name) + (octave + 1) * 12;
  const freqFromMidi = (m) => a4 * Math.pow(2, (m - 69) / 12);
  const midiFromFreq = (f) => 12 * Math.log2(f / a4) + 69;

  function describePitch(freq) {
    const midi = midiFromFreq(freq);
    const nearest = Math.round(midi);
    const cents = (midi - nearest) * 100;
    const name = NOTE_NAMES[((nearest % 12) + 12) % 12];
    const octave = Math.floor(nearest / 12) - 1;
    return { freq, midi, nearest, cents, name, octave };
  }

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    overlay: $('startOverlay'), startBtn: $('startBtn'), status: $('status'),
    noteName: $('noteName'), noteOctave: $('noteOctave'),
    centsValue: $('centsValue'), freqValue: $('freqValue'),
    readout: $('readout'),
    gauge: $('gaugeCanvas'), strobe: $('strobeCanvas'), history: $('historyCanvas'),
    ledStrip: $('ledStrip'), ampFill: $('ampFill'), dbValue: $('dbValue'),
    a4Value: $('a4Value'), a4Up: $('a4Up'), a4Down: $('a4Down'),
    stringGuide: $('stringGuide'), instrumentToggle: $('instrumentToggle'),
  };

  // ---------- State ----------
  let audioCtx = null, analyser = null, mediaStream = null, sourceNode = null;
  let rafId = null, running = false;
  let buffer = null;

  // Smoothed display values
  let smoothCents = 0;        // eased needle position
  let displayFreq = 0;
  let smoothAmp = 0;
  let lastGoodFreq = 0;
  let signalActive = false;
  let strobePhase = 0;
  const TUNED_THRESHOLD = 4;  // cents

  // History ring buffer of cents (null = no signal)
  const HISTORY_LEN = 240;
  const history = new Array(HISTORY_LEN).fill(null);

  // ---------- LED strip ----------
  const LED_COUNT = 21; // -50..+50 in 5-cent steps, center = index 10
  function buildLeds() {
    els.ledStrip.innerHTML = '';
    for (let i = 0; i < LED_COUNT; i++) {
      const led = document.createElement('div');
      led.className = 'led' + (i === 10 ? ' center' : '');
      els.ledStrip.appendChild(led);
    }
  }
  function updateLeds(cents, tuned) {
    const leds = els.ledStrip.children;
    const idx = Math.max(0, Math.min(LED_COUNT - 1, Math.round(cents / 5) + 10));
    for (let i = 0; i < LED_COUNT; i++) {
      const led = leds[i];
      led.className = 'led' + (i === 10 ? ' center' : '');
      if (!signalActive) continue;
      if (tuned && i === 10) { led.classList.add('on-green'); continue; }
      // light a trail from centre toward the active position
      if (i === 10) continue;
      const between = (i > 10 && i <= idx) || (i < 10 && i >= idx);
      if (between) led.classList.add(idx > 10 ? 'on-sharp' : 'on-flat');
    }
  }

  // ---------- String guide ----------
  function buildStrings() {
    els.stringGuide.innerHTML = '';
    INSTRUMENTS[instrument].forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'string-btn';
      btn.dataset.midi = midiFromName(s.name, s.octave);
      btn.innerHTML = `${s.name}<small>${s.name}${s.octave}</small>`;
      els.stringGuide.appendChild(btn);
    });
  }
  function highlightString(nearestMidi) {
    [...els.stringGuide.children].forEach((btn) => {
      btn.classList.toggle('near', signalActive && Number(btn.dataset.midi) === nearestMidi);
    });
  }

  // ---------- Canvas setup (HiDPI) ----------
  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: rect.width, h: rect.height };
  }
  let gauge, strobe, hist;
  function resizeAll() {
    gauge = fitCanvas(els.gauge);
    strobe = fitCanvas(els.strobe);
    hist = fitCanvas(els.history);
  }
  window.addEventListener('resize', () => { resizeAll(); });

  // ---------- Gauge drawing ----------
  function drawGauge(cents, tuned) {
    const { ctx, w, h } = gauge;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h * 0.94;
    const R = Math.min(w * 0.44, h * 0.8);
    const MAXA = Math.PI * 0.42; // sweep maps to ±50 cents
    const a = (c) => (-Math.PI / 2) + (Math.max(-50, Math.min(50, c)) / 50) * MAXA;
    ctx.lineCap = 'round';

    // base track
    ctx.lineWidth = Math.max(5, R * 0.045);
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, a(-50), a(50));
    ctx.stroke();

    // green centre zone
    ctx.strokeStyle = tuned ? 'rgba(52,211,153,.85)' : 'rgba(52,211,153,.40)';
    ctx.beginPath();
    ctx.arc(cx, cy, R, a(-5), a(5));
    ctx.stroke();

    // deviation fill from centre toward needle
    if (signalActive) {
      const col = tuned ? '52,211,153' : (cents < 0 ? '56,189,248' : '251,113,133');
      ctx.strokeStyle = `rgba(${col},.55)`;
      ctx.lineWidth = Math.max(5, R * 0.045);
      const from = a(0), to = a(cents);
      ctx.beginPath();
      ctx.arc(cx, cy, R, Math.min(from, to), Math.max(from, to));
      ctx.stroke();
    }

    // ticks + labels
    ctx.font = `600 ${Math.max(9, R * 0.072)}px "JetBrains Mono", monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let c = -50; c <= 50; c += 5) {
      const ang = a(c);
      const major = c % 25 === 0;
      const r1 = R - (major ? R * 0.12 : R * 0.06);
      const r2 = R - R * 0.02;
      ctx.beginPath();
      ctx.lineWidth = major ? 2 : 1;
      ctx.strokeStyle = c === 0 ? 'rgba(52,211,153,.9)' : 'rgba(232,238,248,.28)';
      ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
      ctx.stroke();
      if (major) {
        const lr = R - R * 0.22;
        ctx.fillStyle = c === 0 ? 'rgba(52,211,153,.9)' : 'rgba(232,238,248,.42)';
        const label = c === 0 ? '0' : (c > 0 ? '+' + c : '' + c);
        ctx.fillText(label, cx + Math.cos(ang) * lr, cy + Math.sin(ang) * lr);
      }
    }

    // needle
    const ang = a(cents);
    const needleColor = !signalActive ? 'rgba(232,238,248,.25)'
      : tuned ? '#34d399' : (cents < 0 ? '#38bdf8' : '#fb7185');
    ctx.save();
    ctx.shadowColor = needleColor; ctx.shadowBlur = signalActive ? 14 : 0;
    ctx.strokeStyle = needleColor;
    ctx.lineWidth = Math.max(2.5, R * 0.02);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * (R * 0.92), cy + Math.sin(ang) * (R * 0.92));
    ctx.stroke();
    ctx.restore();
    // hub
    ctx.beginPath();
    ctx.fillStyle = needleColor;
    ctx.arc(cx, cy, Math.max(4, R * 0.035), 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(7,10,18,.9)'; ctx.stroke();
  }

  // ---------- Strobe drawing ----------
  function drawStrobe(cents, tuned, amp) {
    const { ctx, w, h } = strobe;
    ctx.clearRect(0, 0, w, h);
    // dark base
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.fillRect(0, 0, w, h);

    // phase advances proportional to cents (direction = sharp/flat). Stops when in-tune.
    if (signalActive) strobePhase += (cents / 50) * 0.16;
    const stripeW = 24;
    const offset = (strobePhase * stripeW) % (stripeW * 2);
    const baseColor = !signalActive ? '232,238,248'
      : tuned ? '52,211,153' : (cents < 0 ? '56,189,248' : '251,113,133');
    const intensity = signalActive ? Math.min(1, 0.22 + amp * 1.3) : 0.12;
    for (let x = -stripeW * 2; x < w + stripeW * 2; x += stripeW * 2) {
      ctx.fillStyle = `rgba(${baseColor},${0.5 * intensity})`;
      ctx.fillRect(x + offset, 0, stripeW, h);
    }
    // centre marker
    ctx.fillStyle = 'rgba(232,238,248,.45)';
    ctx.fillRect(w / 2 - 1, 0, 2, h);
    if (tuned) {
      ctx.save();
      ctx.shadowColor = '#34d399'; ctx.shadowBlur = 16;
      ctx.strokeStyle = 'rgba(52,211,153,.85)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(1, 1, w - 2, h - 2);
      ctx.restore();
    }
  }

  // ---------- History drawing ----------
  function pushHistory(cents) { history.push(cents); history.shift(); }
  function drawHistory() {
    const { ctx, w, h } = hist;
    ctx.clearRect(0, 0, w, h);
    // zero line
    ctx.strokeStyle = 'rgba(52,211,153,.22)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    // ±50 guide lines
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    [0.18, 0.82].forEach((p) => { ctx.beginPath(); ctx.moveTo(0, h * p); ctx.lineTo(w, h * p); ctx.stroke(); });

    const stepX = w / HISTORY_LEN;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    let drawing = false;
    ctx.beginPath();
    for (let i = 0; i < HISTORY_LEN; i++) {
      const c = history[i];
      if (c === null) { drawing = false; continue; }
      const x = i * stepX;
      const y = h / 2 - (Math.max(-50, Math.min(50, c)) / 50) * (h / 2 - 4);
      if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y);
    }
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(34,211,238,.2)');
    grad.addColorStop(1, 'rgba(34,211,238,.95)');
    ctx.strokeStyle = grad;
    ctx.shadowColor = 'rgba(34,211,238,.7)'; ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // ---------- Pitch detection (autocorrelation) ----------
  function autoCorrelate(buf, sampleRate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.008) return { freq: -1, rms };

    // trim silent ends
    let r1 = 0, r2 = SIZE - 1;
    const thres = 0.2;
    for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
    for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
    const b = buf.subarray(r1, r2);
    const N = b.length;
    if (N < 16) return { freq: -1, rms };

    const c = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let j = 0; j < N - i; j++) sum += b[j] * b[j + i];
      c[i] = sum;
    }

    // find first dip then the peak
    let d = 0;
    while (d < N - 1 && c[d] > c[d + 1]) d++;
    let maxval = -1, maxpos = -1;
    for (let i = d; i < N; i++) {
      if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
    }
    let T0 = maxpos;
    if (T0 <= 0) return { freq: -1, rms };

    // parabolic interpolation for sub-sample accuracy
    const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
    const aa = (x1 + x3 - 2 * x2) / 2;
    const bb = (x3 - x1) / 2;
    if (aa) T0 = T0 - bb / (2 * aa);

    const freq = sampleRate / T0;
    if (freq < 20 || freq > 5000) return { freq: -1, rms };
    return { freq, rms };
  }

  // ---------- Main loop ----------
  function loop() {
    rafId = requestAnimationFrame(loop);
    if (!analyser) return;
    analyser.getFloatTimeDomainData(buffer);
    const { freq, rms } = autoCorrelate(buffer, audioCtx.sampleRate);

    // amplitude (smoothed) + dB
    const targetAmp = Math.min(1, rms * 6);
    smoothAmp += (targetAmp - smoothAmp) * 0.25;
    els.ampFill.style.height = (smoothAmp * 100).toFixed(1) + '%';
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    els.dbValue.textContent = isFinite(db) ? db.toFixed(0) : '-∞';

    if (freq > 0 && rms > 0.008) {
      signalActive = true;
      idleFrames = 0;
      lastGoodFreq = freq;
      // smooth displayed frequency
      displayFreq = displayFreq ? displayFreq + (freq - displayFreq) * 0.25 : freq;
      const info = describePitch(displayFreq);
      const tuned = Math.abs(info.cents) <= TUNED_THRESHOLD;

      // ease needle
      smoothCents += (info.cents - smoothCents) * 0.3;

      // text
      els.noteName.textContent = info.name.replace('#', '♯');
      els.noteOctave.textContent = info.octave;
      els.centsValue.textContent = (info.cents >= 0 ? '+' : '') + info.cents.toFixed(0);
      els.freqValue.textContent = displayFreq.toFixed(1);

      // readout colour state
      els.readout.classList.remove('flat', 'sharp', 'intune');
      if (tuned) {
        if (!els.readout.classList.contains('intune')) {
          // retrigger pulse
          void els.readout.offsetWidth;
        }
        els.readout.classList.add('intune');
      } else els.readout.classList.add(info.cents < 0 ? 'flat' : 'sharp');

      updateLeds(smoothCents, tuned);
      highlightString(info.nearest);
      pushHistory(info.cents);
      drawGauge(smoothCents, tuned);
      drawStrobe(smoothCents, tuned, smoothAmp);
    } else {
      // decay toward idle
      signalActive = false;
      smoothCents += (0 - smoothCents) * 0.1;
      els.readout.classList.remove('flat', 'sharp', 'intune');
      updateLeds(0, false);
      highlightString(-1);
      pushHistory(null);
      drawGauge(smoothCents, false);
      drawStrobe(0, false, smoothAmp);
      if (signalActiveDecay()) {
        els.noteName.textContent = '–';
        els.noteOctave.textContent = '';
        els.centsValue.textContent = '··';
        els.freqValue.textContent = '0.0';
      }
    }
    drawHistory();
  }

  let idleFrames = 0;
  function signalActiveDecay() { return ++idleFrames > 30; }

  // ---------- Audio start/stop ----------
  async function start() {
    try {
      setStatus('Requesting microphone…');
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
          channelCount: 1,
        },
        video: false,
      });

      sourceNode = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      buffer = new Float32Array(analyser.fftSize);
      sourceNode.connect(analyser);

      running = true;
      els.overlay.classList.add('hidden');
      setStatus('Listening…', 'live');
      resizeAll();
      if (!rafId) loop();
    } catch (err) {
      console.error(err);
      setStatus('Microphone blocked — check browser permissions', 'error');
    }
  }

  function setStatus(msg, cls = '') {
    els.status.textContent = msg;
    els.status.className = 'status' + (cls ? ' ' + cls : '');
  }

  // ---------- Controls ----------
  els.startBtn.addEventListener('click', start);

  els.a4Up.addEventListener('click', () => { a4 = Math.min(466, a4 + 1); els.a4Value.textContent = a4; });
  els.a4Down.addEventListener('click', () => { a4 = Math.max(415, a4 - 1); els.a4Value.textContent = a4; });

  els.instrumentToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    instrument = btn.dataset.instrument;
    [...els.instrumentToggle.children].forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    buildStrings();
  });

  // click a string to hear/target it (visual target only)
  els.stringGuide.addEventListener('click', (e) => {
    const btn = e.target.closest('.string-btn');
    if (!btn) return;
    [...els.stringGuide.children].forEach((b) => b.classList.toggle('active', b === btn));
  });

  // ---------- Init ----------
  function init() {
    buildLeds();
    buildStrings();
    resizeAll();
    drawGauge(0, false);
    drawHistory();
    drawStrobe(0, false, 0);
    els.a4Value.textContent = a4;
  }
  init();

  // ---------- PWA ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW failed', e));
    });
  }
})();
