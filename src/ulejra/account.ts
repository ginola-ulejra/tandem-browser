import type { ConfigManager } from '../config/manager';
import { SecretStore } from '../security/secret-store';
import { createLogger } from '../utils/logger';

const log = createLogger('UlejraAccount');

/**
 * The user's Ulejra account: the same account as the Ulejra web app (LibreChat).
 *
 * Sign-in is passwordless: the backend emails a 6-digit code (`/api/auth/email-code/request`),
 * and redeeming it (`/api/auth/email-code/verify`) signs in, or creates the account when the
 * address has none and a name is given. The refresh token the backend sets as a cookie is kept
 * encrypted in the secret store. Access tokens (15 minutes) live in
 * memory only and are renewed through `/api/auth/refresh`. The renderer never sees either token.
 *
 * The refresh token is bound to the backend origin it came from: if the configured backend URL
 * changes (config is writable over the local API), the account reads as signed out and the token
 * is never sent to the new address.
 *
 * The token is never written to disk unencrypted: when the OS keychain refuses (safeStorage
 * unavailable), the sign-in lasts for this session only and the user signs in again next time.
 */

const SECRET_KEY = 'ulejra-account';
/** Renew an access token this long before it expires. */
const RENEW_BEFORE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** 1,000,000 LibreChat token credits = $1. */
const CREDITS_PER_USD = 1_000_000;

interface StoredAccount {
  origin: string;
  refreshToken: string;
  email: string;
  name?: string;
}

export type UlejraAccountErrorCode =
  | 'invalid_backend_url'
  | 'invalid_email'
  | 'invalid_code'
  | 'invalid_name'
  | 'code_login_unavailable'
  | 'two_factor_unsupported'
  | 'rate_limited'
  | 'backend_unreachable'
  | 'signed_out';

export class UlejraAccountError extends Error {
  constructor(readonly code: UlejraAccountErrorCode, message: string) {
    super(message);
    this.name = 'UlejraAccountError';
  }
}

export interface UlejraBalance {
  tokenCredits: number;
  usd: number;
}

export interface UlejraCodeSent {
  email: string;
  /** Seconds until another code can be requested. */
  resendAfterSec: number;
}

/** A redeemed code for an address without an account: send it again with a name. */
export interface UlejraNameRequired {
  signedIn: false;
  nameRequired: true;
  backendUrl: string;
}

export interface UlejraAccountStatus {
  signedIn: boolean;
  backendUrl: string;
  email?: string;
  name?: string;
  /** null when the backend does not meter usage. */
  balance?: UlejraBalance | null;
  /** Set when the account is signed in but the backend could not be asked about it. */
  error?: string;
  /** False when the OS keychain was unavailable: the sign-in ends when the app quits. */
  remembered?: boolean;
}

/** The backend's origin, or an error for anything but https (http only for this computer). */
export function resolveBackendOrigin(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new UlejraAccountError('invalid_backend_url', 'The Ulejra server address is not a valid URL.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new UlejraAccountError(
      'invalid_backend_url',
      'The Ulejra server address must use https (http is only allowed for localhost).',
    );
  }
  return url.origin;
}

function readRefreshCookie(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  for (const cookie of cookies) {
    const match = /(?:^|[;,]\s*)refreshToken=([^;]+)/.exec(cookie);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  }
  return null;
}

/** The `exp` of a JWT in milliseconds; falls back to 15 minutes from now. */
function tokenExpiry(token: string, now: number): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    if (typeof payload.exp === 'number') {
      return payload.exp * 1000;
    }
  } catch {
    /* not a JWT we can read */
  }
  return now + 15 * 60_000;
}

interface BackendAnswer {
  message?: string;
  code?: string;
  retryAfterSec?: number;
  resendAfterSec?: number;
}

async function readAnswer(response: Response): Promise<BackendAnswer> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    return {
      message: typeof body.message === 'string' ? body.message : undefined,
      code: typeof body.code === 'string' ? body.code : undefined,
      retryAfterSec: typeof body.retryAfterSec === 'number' ? body.retryAfterSec : undefined,
      resendAfterSec: typeof body.resendAfterSec === 'number' ? body.resendAfterSec : undefined,
    };
  } catch {
    return {};
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(trimmed) || trimmed.length > 120) {
    throw new UlejraAccountError('invalid_email', 'Enter a valid email address.');
  }
  return trimmed;
}

export interface UlejraAccountOptions {
  secrets?: SecretStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class UlejraAccount {
  private readonly secrets: SecretStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private access: { token: string; expiresAt: number; origin: string } | null = null;
  private refreshing: Promise<string> | null = null;
  /** The account when the keychain could not encrypt it: kept for this session only. */
  private sessionOnly: StoredAccount | null = null;

  constructor(private readonly configManager: ConfigManager, options: UlejraAccountOptions = {}) {
    this.secrets = options.secrets ?? new SecretStore({ allowPlaintextFallbackOnInit: false });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  backendUrl(): string {
    return this.configManager.getConfig().ulejra.backendUrl;
  }

  /** Emails a 6-digit sign-in code. The answer does not say whether the address has an account. */
  async requestCode(email: string): Promise<UlejraCodeSent> {
    const origin = resolveBackendOrigin(this.backendUrl());
    const address = normalizeEmail(email);
    const response = await this.request(`${origin}/api/auth/email-code/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: address }),
    });
    const answer = await readAnswer(response);
    if (response.ok) {
      return { email: address, resendAfterSec: answer.resendAfterSec ?? 60 };
    }
    if (response.status === 429 && answer.code === 'resend_too_soon') {
      // A code was sent moments ago and is still valid: use that one.
      return { email: address, resendAfterSec: answer.retryAfterSec ?? 60 };
    }
    throw this.codeError(response.status, answer, 'The code could not be sent. Try again shortly.');
  }

  /**
   * Redeems an emailed code: signs in, or creates the account when the address has none and a
   * name is given. Without a name for a new address the answer is `nameRequired`.
   */
  async verifyCode(email: string, code: string, name?: string): Promise<UlejraAccountStatus | UlejraNameRequired> {
    const origin = resolveBackendOrigin(this.backendUrl());
    const address = normalizeEmail(email);
    const digits = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(digits)) {
      throw new UlejraAccountError('invalid_code', 'Enter the 6-digit code from the email.');
    }
    const trimmedName = name?.trim();
    const response = await this.request(`${origin}/api/auth/email-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: address, code: digits, ...(trimmedName ? { name: trimmedName } : {}) }),
    });
    if (!response.ok) {
      throw this.codeError(response.status, await readAnswer(response), 'The code could not be checked.');
    }
    const body = (await response.json()) as {
      nameRequired?: boolean;
      token?: string;
      twoFAPending?: boolean;
      user?: { email?: string; name?: string; username?: string };
    };
    if (body.nameRequired) {
      return { signedIn: false, nameRequired: true, backendUrl: this.backendUrl() };
    }
    if (body.twoFAPending) {
      throw new UlejraAccountError(
        'two_factor_unsupported',
        'This account uses two-factor sign-in, which the desktop app does not support yet.',
      );
    }
    const refreshToken = readRefreshCookie(response);
    if (!body.token || !refreshToken) {
      throw new UlejraAccountError('backend_unreachable', 'The Ulejra server did not complete the sign-in.');
    }
    this.store({
      origin,
      refreshToken,
      email: body.user?.email ?? address,
      name: body.user?.name || body.user?.username || undefined,
    });
    this.access = { token: body.token, expiresAt: tokenExpiry(body.token, this.now()), origin };
    log.info('Signed in to Ulejra');
    return this.status();
  }

  private codeError(status: number, answer: BackendAnswer, fallback: string): UlejraAccountError {
    const message = answer.message ?? fallback;
    if (status === 404) {
      return new UlejraAccountError(
        'code_login_unavailable',
        'This Ulejra server does not offer sign-in with an email code.',
      );
    }
    if (status === 429) {
      return new UlejraAccountError('rate_limited', message);
    }
    if (answer.code === 'invalid_code') {
      return new UlejraAccountError('invalid_code', message);
    }
    if (answer.code === 'invalid_name') {
      return new UlejraAccountError('invalid_name', message);
    }
    if (status === 400 || status === 403) {
      return new UlejraAccountError('invalid_email', message);
    }
    return new UlejraAccountError('backend_unreachable', message);
  }

  /** Signs out here and, best effort, on the server. */
  async logout(): Promise<UlejraAccountStatus> {
    const stored = this.read();
    const access = this.access;
    this.access = null;
    this.forget();
    if (stored && access && access.origin === stored.origin) {
      try {
        await this.request(`${stored.origin}/api/auth/logout`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${access.token}`,
            cookie: `refreshToken=${encodeURIComponent(stored.refreshToken)}`,
          },
        });
      } catch (error) {
        log.warn('Server sign-out failed:', error instanceof Error ? error.message : String(error));
      }
    }
    return { signedIn: false, backendUrl: this.backendUrl() };
  }

  /** A valid access token, renewed when close to expiry. Throws `signed_out` without an account. */
  async getAccessToken(): Promise<string> {
    const stored = this.current();
    if (!stored) {
      this.access = null;
      throw new UlejraAccountError('signed_out', 'Sign in to Ulejra in Settings first.');
    }
    if (this.access && this.access.origin === stored.origin && this.access.expiresAt - RENEW_BEFORE_MS > this.now()) {
      return this.access.token;
    }
    this.refreshing ??= this.refresh(stored).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * A request to the Ulejra backend as the signed-in user. Retries once with a renewed token
   * when the server answers 401.
   */
  async authorizedFetch(pathname: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const stored = this.current();
    if (!stored) {
      throw new UlejraAccountError('signed_out', 'Sign in to Ulejra in Settings first.');
    }
    const send = (token: string) =>
      this.request(`${stored.origin}${pathname}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
      }, timeoutMs);
    const first = await send(await this.getAccessToken());
    if (first.status !== 401) {
      return first;
    }
    this.access = null;
    return send(await this.getAccessToken());
  }

  async status(): Promise<UlejraAccountStatus> {
    const backendUrl = this.backendUrl();
    const stored = this.current();
    if (!stored) {
      return { signedIn: false, backendUrl };
    }
    const base: UlejraAccountStatus = {
      signedIn: true,
      backendUrl,
      email: stored.email,
      name: stored.name,
      remembered: this.sessionOnly === null,
    };
    try {
      const response = await this.authorizedFetch('/api/balance');
      if (response.status === 204) {
        return { ...base, balance: null };
      }
      if (!response.ok) {
        return { ...base, error: `The Ulejra server answered ${response.status}.` };
      }
      const body = (await response.json()) as { tokenCredits?: number };
      const tokenCredits = Number(body.tokenCredits ?? 0);
      return { ...base, balance: { tokenCredits, usd: tokenCredits / CREDITS_PER_USD } };
    } catch (error) {
      if (error instanceof UlejraAccountError && error.code === 'signed_out') {
        return { signedIn: false, backendUrl };
      }
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async refresh(stored: StoredAccount): Promise<string> {
    const response = await this.request(`${stored.origin}/api/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `refreshToken=${encodeURIComponent(stored.refreshToken)}` },
    });
    const body = response.ok
      ? ((await response.json().catch(() => null)) as { token?: string } | null)
      : null;
    if (!body?.token) {
      if (response.ok || response.status === 401 || response.status === 403) {
        // The server no longer accepts this session: sign out here too.
        this.access = null;
        this.forget();
        throw new UlejraAccountError('signed_out', 'Your Ulejra session has ended. Sign in again in Settings.');
      }
      throw new UlejraAccountError('backend_unreachable', `The Ulejra server answered ${response.status}.`);
    }
    const rotated = readRefreshCookie(response);
    if (rotated && rotated !== stored.refreshToken) {
      this.store({ ...stored, refreshToken: rotated });
    }
    this.access = { token: body.token, expiresAt: tokenExpiry(body.token, this.now()), origin: stored.origin };
    return body.token;
  }

  private async request(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    } catch (error) {
      if (init.signal?.aborted) {
        throw error;
      }
      throw new UlejraAccountError(
        'backend_unreachable',
        `Could not reach the Ulejra server (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  /** The stored account, only while it belongs to the configured backend. */
  private current(): StoredAccount | null {
    const stored = this.read();
    if (!stored) {
      return null;
    }
    try {
      return resolveBackendOrigin(this.backendUrl()) === stored.origin ? stored : null;
    } catch {
      return null;
    }
  }

  private read(): StoredAccount | null {
    if (this.sessionOnly) {
      return this.sessionOnly;
    }
    try {
      const raw = this.secrets.get(SECRET_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as Partial<StoredAccount>;
      if (typeof parsed.origin !== 'string' || typeof parsed.refreshToken !== 'string' || typeof parsed.email !== 'string') {
        return null;
      }
      return parsed as StoredAccount;
    } catch (error) {
      log.warn('Could not read the stored Ulejra account:', error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private store(account: StoredAccount): void {
    try {
      this.secrets.set(SECRET_KEY, JSON.stringify(account));
      this.sessionOnly = null;
    } catch (error) {
      log.warn(
        'Keychain encryption unavailable; keeping the Ulejra sign-in for this session only:',
        error instanceof Error ? error.message : String(error),
      );
      this.secrets.delete(SECRET_KEY);
      this.sessionOnly = account;
    }
  }

  private forget(): void {
    this.sessionOnly = null;
    this.secrets.delete(SECRET_KEY);
  }
}
