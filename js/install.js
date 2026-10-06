// Install prompt: on a phone, the game works best as an installed app (home-screen icon, full screen, no browser bar).
// In a normal browser tab the player gets a full-screen panel with an install button. It can be closed ("Not now"),
// and it is not shown again in that browser tab's session.
//
// What the platforms allow:
//  - Android (Chrome and most Chromium browsers): a real one-tap install through the `beforeinstallprompt` event.
//  - iPhone/iPad: Apple gives websites no install button. The panel shows the three taps (Share, Add to Home Screen, Add).
//  - In-app browsers (Instagram, Facebook, ...) cannot install anything: the panel asks the player to open the link in
//    Safari or Chrome.
import { CONFIG } from './config.js';
import { hasBackend } from './api.js';

const ua = navigator.userAgent || '';
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(ua);
const isMobile = isIOS || isAndroid;
const inAppBrowser = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Snapchat|TikTok|Twitter|LinkedInApp|; wv\)/i.test(ua);

export function isStandalone() {
  const mq = (q) => window.matchMedia?.(q).matches;
  return Boolean(mq('(display-mode: standalone)') || mq('(display-mode: fullscreen)') || navigator.standalone === true
    || document.referrer.startsWith('android-app://'));
}

/** Skipped for this tab's session: after "Not now", or with ?noinstall=1 (handy for organisers). */
function skipped() {
  try {
    if (new URLSearchParams(location.search).has('noinstall')) sessionStorage.setItem('kq-noinstall', '1');
    return sessionStorage.getItem('kq-noinstall') === '1';
  } catch { return false; }
}

export function installPromptWanted() {
  if (!CONFIG.promptInstall || !hasBackend) return false;            // demo mode stays open
  return isMobile && !isStandalone() && !skipped();
}

const steps = (items) => `<ol class="ig-steps">${items.map((s) => `<li>${s}</li>`).join('')}</ol>`;
const SHARE = '<svg class="ig-share" viewBox="0 0 24 24" aria-label="Share" role="img"><path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Shows the install panel. `onClose` runs when the player taps "Not now" (the game then starts in the browser tab as usual). */
export function showInstallGate(onClose) {
  document.documentElement.classList.add('install-locked');
  const root = document.createElement('div');
  root.id = 'installGate';
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'igTitle');
  root.innerHTML = `<div class="ig-card">
    <img class="ig-emblem" src="./assets/brand/kryptex-logo-256.png" alt="" width="112" height="112" />
    <h1 id="igTitle" class="outlined ig-title">Install the app</h1>
    <p class="ig-copy">Kryptex Quest plays best as an app: full screen, steadier GPS and no browser bars. It takes a few seconds.</p>
    <div id="igBody"></div>
    <p class="ig-fine">Already installed? Open <b>Kryptex Quest</b> from your home screen.</p>
    <button id="igClose" class="ghost-button ig-close" type="button">Not now</button>
  </div>`;
  // Nothing behind the panel may be reachable (tap, tab or screen reader).
  for (const el of document.body.children) { el.inert = true; el.setAttribute('aria-hidden', 'true'); }
  document.body.append(root);
  const body = root.querySelector('#igBody');
  const close = () => {
    try { sessionStorage.setItem('kq-noinstall', '1'); } catch { /* fine */ }
    for (const el of document.body.children) { el.inert = false; el.removeAttribute('aria-hidden'); }
    root.remove();
    document.documentElement.classList.remove('install-locked');
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey, true);
  root.querySelector('#igClose').addEventListener('click', close);

  const installButton = () => '<button id="igInstall" class="primary-button ig-install" type="button">Install Kryptex Quest</button>';
  let finished = false;
  const done = () => {
    finished = true;
    body.innerHTML = '<div class="ig-done"><b>Installed!</b><span>Open <b>Kryptex Quest</b> from your home screen to play in the app.</span></div>';
  };

  const render = () => {
    if (finished) return;
    if (inAppBrowser) {
      body.innerHTML = `<p class="ig-warn">This in-app browser cannot install apps.</p>${steps([
        `Open this page in <b>${isIOS ? 'Safari' : 'Chrome'}</b> (use the menu or "Open in browser").`,
        'Then come back to this screen and install.',
      ])}<button id="igCopy" class="ghost-button" type="button">Copy the link</button>`;
      root.querySelector('#igCopy').onclick = async (e) => {
        try { await navigator.clipboard.writeText(location.origin + '/'); e.target.textContent = 'Link copied. Paste it in your browser.'; } catch { e.target.textContent = location.origin; }
      };
      return;
    }
    if (window.__bip) { body.innerHTML = installButton(); root.querySelector('#igInstall').onclick = install; return; }
    if (isIOS) {
      body.innerHTML = steps([
        `Tap the <b>Share</b> button ${SHARE} in Safari's toolbar.`,
        'Scroll down and tap <b>Add to Home Screen</b>.',
        'Tap <b>Add</b>, then open <b>Kryptex Quest</b> from your home screen.',
      ]) + '<p class="ig-note">Apple does not allow a one-tap install button on iPhone. Using another browser? Open this page in Safari first.</p>';
      return;
    }
    body.innerHTML = steps([
      'Tap the <b>menu</b> (the three dots) in your browser.',
      'Tap <b>Install app</b> or <b>Add to Home screen</b>.',
      'Open <b>Kryptex Quest</b> from your home screen.',
    ]) + '<p class="ig-note">Waiting for your browser to offer the install button...</p>';
  };

  async function install() {
    const prompt = window.__bip;
    if (!prompt) return render();
    window.__bip = null;                                   // a prompt can be used once
    body.querySelector('#igInstall')?.setAttribute('disabled', '');
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === 'accepted') return done();
    } catch { /* fall through to the manual steps */ }
    render();
    body.insertAdjacentHTML('afterbegin', '<p class="ig-warn">The install was not completed. You can try again or tap Not now.</p>');
  }

  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); window.__bip = event; render(); });
  window.addEventListener('appinstalled', done);
  render();
}
