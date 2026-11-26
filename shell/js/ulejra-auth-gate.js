// Ulejra launch screen: when the app opens and no Ulejra account is signed in, ask to sign in or
// create one (code by email) before anything else. "Not now" keeps browsing without an account;
// the screen comes back on the next launch.
//
// window.ulejraAuthGate.done resolves once the screen is closed or not needed, so the onboarding
// tour (shortcuts.js) waits for it instead of opening on top of it.
(function () {
  const apiBase = () =>
    window.tandemApi?.baseUrl?.() || window.__TANDEM_API_BASE__ || 'http://127.0.0.1:8765';

  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  window.ulejraAuthGate = { done };

  async function readStatus() {
    // The local API starts with the window; give it a few tries.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const res = await fetch(`${apiBase()}/integrations/ulejra/status`);
        if (res.ok) return await res.json();
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  function close(overlay) {
    overlay.hidden = true;
    finish();
  }

  async function start() {
    const overlay = document.getElementById('ulejra-auth-overlay');
    const container = document.getElementById('ulejra-auth-form');
    if (!overlay || !container || !window.UlejraAuthForm) {
      finish();
      return;
    }
    const status = await readStatus();
    if (!status || status.signedIn) {
      finish();
      return;
    }
    const form = window.UlejraAuthForm.mount(container, {
      onSignedIn: () => close(overlay),
    });
    document.getElementById('ulejra-auth-later')?.addEventListener('click', () => close(overlay));
    overlay.hidden = false;
    form.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
