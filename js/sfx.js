// Small game sounds (Kenney Interface Sounds + RPG Audio, CC0; see assets/CREDITS.md). Off switch lives in the menu.
const NAMES = ['tap', 'open', 'close', 'success', 'error', 'discover', 'unlock', 'coins', 'cleared', 'bong'];
const cache = {};
let enabled = true;
try { enabled = localStorage.getItem('kq-sound') !== 'off'; } catch { /* storage unavailable */ }

export const soundOn = () => enabled;
export function setSound(on) {
  enabled = on;
  try { localStorage.setItem('kq-sound', on ? 'on' : 'off'); } catch { /* optional */ }
}
export function sfx(name, volume = 0.55) {
  if (!enabled || !NAMES.includes(name)) return;
  try {
    const audio = (cache[name] ||= new Audio(`./assets/audio/${name}.mp3`));
    audio.volume = volume; audio.currentTime = 0;
    audio.play().catch(() => { /* autoplay blocked until the first tap */ });
  } catch { /* no audio support */ }
}
