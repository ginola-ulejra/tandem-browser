// Ulejra sign-in and sign-up with a code sent by email, shared by the launch screen
// (index.html) and Settings > Ulejra Account. Talks only to the local API
// (/integrations/ulejra/code/*), which forwards to the Ulejra server; tokens never reach the page.
//
//   UlejraAuthForm.mount(container, { onSignedIn(status) }) -> { reset(), focus() }
//
// "Create account" asks for the name up front. "Sign in" with an address that has no account
// asks for the name after the code, as the server answers `nameRequired`.
(function () {
  const apiBase = () =>
    window.tandemApi?.baseUrl?.() || window.__TANDEM_API_BASE__ || 'http://127.0.0.1:8765';

  const NAME_MIN = 3;
  const NAME_MAX = 80;

  const TEMPLATE = `
    <div class="uaf-tabs" role="tablist" aria-label="Ulejra account">
      <button type="button" role="tab" class="uaf-tab" data-mode="signin">Sign in</button>
      <button type="button" role="tab" class="uaf-tab" data-mode="signup">Create account</button>
    </div>
    <form class="uaf-step" data-step="email" novalidate>
      <label class="uaf-field" data-signup-only>
        <span class="uaf-label">Your name</span>
        <input class="uaf-input" name="name" type="text" autocomplete="name" maxlength="${NAME_MAX}" />
      </label>
      <label class="uaf-field">
        <span class="uaf-label">Email</span>
        <input class="uaf-input" name="email" type="email" autocomplete="email" maxlength="120" placeholder="you@example.com" />
      </label>
      <p class="uaf-error" role="alert"></p>
      <button class="uaf-primary" type="submit">Send code</button>
    </form>
    <form class="uaf-step" data-step="code" novalidate hidden>
      <p class="uaf-notice" role="status"></p>
      <label class="uaf-field">
        <span class="uaf-label">6-digit code</span>
        <input class="uaf-input uaf-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" />
      </label>
      <label class="uaf-field" data-late-name hidden>
        <span class="uaf-label">Your name</span>
        <span class="uaf-hint">No account uses this email yet. Enter your name to create one.</span>
        <input class="uaf-input" name="lateName" type="text" autocomplete="name" maxlength="${NAME_MAX}" />
      </label>
      <p class="uaf-error" role="alert"></p>
      <button class="uaf-primary" type="submit">Sign in</button>
      <div class="uaf-links">
        <button type="button" class="uaf-link" data-action="resend">Resend code</button>
        <button type="button" class="uaf-link" data-action="change">Use a different email</button>
      </div>
    </form>`;

  async function post(path, body) {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, body: json };
  }

  function mount(root, options = {}) {
    root.classList.add('uaf');
    root.innerHTML = TEMPLATE;

    const $ = (selector) => root.querySelector(selector);
    const emailForm = $('[data-step="email"]');
    const codeForm = $('[data-step="code"]');
    const nameInput = emailForm.elements.name;
    const emailInput = emailForm.elements.email;
    const codeInput = codeForm.elements.code;
    const lateNameInput = codeForm.elements.lateName;
    const emailError = emailForm.querySelector('.uaf-error');
    const codeError = codeForm.querySelector('.uaf-error');
    const sendButton = emailForm.querySelector('.uaf-primary');
    const verifyButton = codeForm.querySelector('.uaf-primary');
    const resendButton = $('[data-action="resend"]');

    const state = { mode: 'signin', email: '', needsLateName: false, resendAt: 0, timer: null };

    function verifyLabel() {
      return state.mode === 'signup' || state.needsLateName ? 'Create account' : 'Sign in';
    }

    function validName(value) {
      const name = value.trim();
      if (name.length < NAME_MIN || name.length > NAME_MAX) {
        return `Your name must be ${NAME_MIN} to ${NAME_MAX} characters.`;
      }
      return null;
    }

    function showStep(step) {
      emailForm.hidden = step !== 'email';
      codeForm.hidden = step !== 'code';
      emailError.textContent = '';
      codeError.textContent = '';
      if (step === 'email') {
        clearInterval(state.timer);
        state.needsLateName = false;
        codeForm.querySelector('[data-late-name]').hidden = true;
        codeInput.value = '';
      }
      verifyButton.textContent = verifyLabel();
    }

    function setMode(mode, focus = true) {
      state.mode = mode;
      for (const tab of root.querySelectorAll('.uaf-tab')) {
        const selected = tab.dataset.mode === mode;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-selected', String(selected));
      }
      emailForm.querySelector('[data-signup-only]').hidden = mode !== 'signup';
      showStep('email');
      if (focus) (mode === 'signup' ? nameInput : emailInput).focus();
    }

    function tickResend() {
      const left = Math.ceil((state.resendAt - Date.now()) / 1000);
      resendButton.disabled = left > 0;
      resendButton.textContent = left > 0 ? `Resend code (${left}s)` : 'Resend code';
      if (left <= 0) clearInterval(state.timer);
    }

    async function sendCode(fromCodeStep) {
      const errorEl = fromCodeStep ? codeError : emailError;
      const button = fromCodeStep ? resendButton : sendButton;
      errorEl.textContent = '';
      if (!fromCodeStep && state.mode === 'signup') {
        const nameProblem = validName(nameInput.value);
        if (nameProblem) {
          errorEl.textContent = nameProblem;
          nameInput.focus();
          return;
        }
      }
      const email = fromCodeStep ? state.email : emailInput.value.trim();
      if (!email) {
        errorEl.textContent = 'Enter your email address.';
        emailInput.focus();
        return;
      }
      button.disabled = true;
      try {
        const { ok, body } = await post('/integrations/ulejra/code/request', { email });
        if (!ok) {
          errorEl.textContent = body.error || 'The code could not be sent.';
          return;
        }
        state.email = body.email;
        if (!fromCodeStep) showStep('code');
        codeForm.querySelector('.uaf-notice').textContent =
          `We sent a 6-digit code to ${body.email}. It expires in 10 minutes.`;
        state.resendAt = Date.now() + (body.resendAfterSec || 60) * 1000;
        clearInterval(state.timer);
        state.timer = setInterval(tickResend, 1000);
        codeInput.focus();
      } catch {
        errorEl.textContent = 'Ulejra is not responding. Try again.';
      } finally {
        if (fromCodeStep) tickResend();
        else button.disabled = false;
      }
    }

    async function verifyCode() {
      codeError.textContent = '';
      const code = codeInput.value.replace(/\D/g, '');
      if (code.length !== 6) {
        codeError.textContent = 'Enter the 6-digit code from the email.';
        codeInput.focus();
        return;
      }
      let name;
      if (state.needsLateName) {
        const problem = validName(lateNameInput.value);
        if (problem) {
          codeError.textContent = problem;
          lateNameInput.focus();
          return;
        }
        name = lateNameInput.value.trim();
      } else if (state.mode === 'signup') {
        name = nameInput.value.trim();
      }
      verifyButton.disabled = true;
      try {
        const { ok, body } = await post('/integrations/ulejra/code/verify', {
          email: state.email,
          code,
          ...(name ? { name } : {}),
        });
        if (!ok) {
          codeError.textContent = body.error || 'Sign-in failed.';
          return;
        }
        if (body.nameRequired) {
          state.needsLateName = true;
          codeForm.querySelector('[data-late-name]').hidden = false;
          verifyButton.textContent = verifyLabel();
          lateNameInput.focus();
          return;
        }
        reset();
        options.onSignedIn?.(body);
      } catch {
        codeError.textContent = 'Ulejra is not responding. Try again.';
      } finally {
        verifyButton.disabled = false;
      }
    }

    function reset() {
      codeInput.value = '';
      lateNameInput.value = '';
      setMode(state.mode, false);
    }

    for (const tab of root.querySelectorAll('.uaf-tab')) {
      tab.addEventListener('click', () => setMode(tab.dataset.mode));
    }
    emailForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendCode(false);
    });
    codeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      verifyCode();
    });
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    });
    resendButton.addEventListener('click', () => sendCode(true));
    $('[data-action="change"]').addEventListener('click', () => {
      showStep('email');
      emailInput.focus();
    });

    setMode(options.initialMode === 'signup' ? 'signup' : 'signin', false);
    return { reset, focus: () => (state.mode === 'signup' ? nameInput : emailInput).focus() };
  }

  window.UlejraAuthForm = { mount };
})();
