// Game sounds, synthesised in the browser (Web Audio): no files to load, nothing to license. Off switch lives in the menu.
const NAMES = ['tap', 'open', 'close', 'success', 'error', 'discover', 'unlock', 'coins', 'cleared', 'bong'];
let enabled = true;
let ctx = null;
try { enabled = localStorage.getItem('kq-sound') !== 'off'; } catch { /* storage unavailable */ }

export const soundOn = () => enabled;
export function setSound(on) {
  enabled = on;
  try { localStorage.setItem('kq-sound', on ? 'on' : 'off'); } catch { /* optional */ }
}

// One note: type, frequency (optionally gliding to `to`), start offset, length, relative loudness.
const NOTES = {
  tap: [['triangle', 520, 0, 0.06, 0.5, 380]],
  open: [['triangle', 392, 0, 0.09, 0.5], ['triangle', 587, 0.07, 0.14, 0.5]],
  close: [['triangle', 587, 0, 0.08, 0.45], ['triangle', 392, 0.07, 0.12, 0.45]],
  success: [['sine', 523, 0, 0.14, 0.6], ['sine', 659, 0.1, 0.14, 0.6], ['sine', 784, 0.2, 0.28, 0.6]],
  error: [['sawtooth', 190, 0, 0.18, 0.35, 120], ['square', 150, 0.14, 0.2, 0.25, 90]],
  discover: [['sine', 659, 0, 0.12, 0.5], ['sine', 880, 0.1, 0.12, 0.5], ['sine', 1175, 0.2, 0.12, 0.5], ['sine', 1568, 0.3, 0.4, 0.45]],
  unlock: [['square', 220, 0, 0.07, 0.3], ['square', 330, 0.08, 0.07, 0.3], ['sine', 988, 0.18, 0.12, 0.55], ['sine', 1319, 0.28, 0.36, 0.55]],
  coins: [['sine', 1568, 0, 0.07, 0.5], ['sine', 2093, 0.07, 0.07, 0.5], ['sine', 1568, 0.16, 0.07, 0.45], ['sine', 2093, 0.23, 0.2, 0.45]],
  cleared: [['triangle', 392, 0, 0.12, 0.55], ['triangle', 523, 0.12, 0.12, 0.55], ['triangle', 659, 0.24, 0.12, 0.55], ['triangle', 784, 0.36, 0.12, 0.55], ['sine', 1047, 0.5, 0.6, 0.6]],
  bong: [['sine', 196, 0, 0.9, 0.7], ['sine', 392, 0, 0.6, 0.25]],
};

export function sfx(name, volume = 0.55) {
  if (!enabled || !NAMES.includes(name)) return;
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    for (const [type, freq, at, len, gain, to] of NOTES[name]) {
      const osc = ctx.createOscillator(); const amp = ctx.createGain();
      osc.type = type; osc.frequency.setValueAtTime(freq, t0 + at);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + at + len);
      amp.gain.setValueAtTime(0.0001, t0 + at);
      amp.gain.exponentialRampToValueAtTime(gain * volume * 0.5, t0 + at + 0.01);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      osc.connect(amp).connect(ctx.destination);
      osc.start(t0 + at); osc.stop(t0 + at + len + 0.05);
    }
  } catch { /* no audio support or blocked until the first tap */ }
}
