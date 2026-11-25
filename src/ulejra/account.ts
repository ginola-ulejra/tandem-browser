import type { ConfigManager } from '../config/manager';
import { SecretStore } from '../security/secret-store';
import { createLogger } from '../utils/logger';

const log = createLogger('UlejraAccount');

/**
 * The user's Ulejra account: the same email and password as the Ulejra web app (LibreChat).
 *
 * Signing in posts the password once to the backend's `/api/auth/login` and keeps the refresh
 * token it sets as a cookie, encrypted in the secret store. Access tokens (15 minutes) live in
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
  | 'invalid_credentials'
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

async function readMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : undefined;
  } catch {
    return undefined;
  }
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

  /** Signs in with the Ulejra web account. The password is sent once and never stored. */
  async login(email: string, password: string): Promise<UlejraAccountStatus> {
    const origin = resolveBackendOrigin(this.backendUrl());
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      throw new UlejraAccountError('invalid_credentials', 'Enter your Ulejra email and password.');
    }
    const response = await this.request(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: trimmedEmail, password }),
    });
    if (response.status === 429) {
      throw new UlejraAccountError('rate_limited', 'Too many sign-in attempts. Try again in a few minutes.');
    }
    if (!response.ok) {
      const message = await readMessage(response);
      throw new UlejraAccountError('invalid_credentials', message ?? 'Email or password is incorrect.');
    }
    const body = (await response.json()) as {
      token?: string;
      twoFAPending?: boolean;
      user?: { email?: string; name?: string; username?: string };
    };
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
      email: body.user?.email ?? trimmedEmail,
      name: body.user?.name || body.user?.username || undefined,
    });
    this.access = { token: body.token, expiresAt: tokenExpiry(body.token, this.now()), origin };
    log.info('Signed in to Ulejra');
    return this.status();
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
