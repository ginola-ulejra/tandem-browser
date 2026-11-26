import { describe, expect, it, vi } from 'vitest';
import type { ConfigManager } from '../../config/manager';
import type { SecretStore } from '../../security/secret-store';
import { UlejraAccount, UlejraAccountError, resolveBackendOrigin } from '../account';

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const NOW = 1_800_000_000_000;

function jwt(expiresAtMs: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ id: 'user-1', exp: Math.floor(expiresAtMs / 1000) })}.sig`;
}

function json(body: unknown, init: { status?: number; cookie?: string } = {}): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.cookie) headers.append('set-cookie', init.cookie);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function memorySecrets() {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      get: (key: string) => values.get(key) ?? null,
      set: (key: string, value: string) => {
        values.set(key, value);
        return { encoding: 'safe-storage', path: key };
      },
      delete: (key: string) => {
        values.delete(key);
      },
    } as unknown as SecretStore,
  };
}

function setup(responses: Array<(url: string, init: RequestInit) => Response>, backendUrl = 'http://localhost:3080') {
  const config = { ulejra: { backendUrl } };
  const configManager = { getConfig: () => config } as unknown as ConfigManager;
  const secrets = memorySecrets();
  let now = NOW;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return next(url, init);
  });
  const account = new UlejraAccount(configManager, {
    secrets: secrets.store,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => now,
  });
  return {
    account,
    config,
    secrets,
    fetchImpl,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const loginOk = () =>
  json(
    { token: jwt(NOW + 15 * 60_000), user: { email: 'sme@example.com', name: 'Warung Sari' } },
    { cookie: 'refreshToken=refresh-1; Path=/api; HttpOnly; SameSite=Strict' },
  );
const balance = (tokenCredits: number) => json({ tokenCredits });

describe('resolveBackendOrigin', () => {
  it('accepts https anywhere and http only on this computer', () => {
    expect(resolveBackendOrigin('https://app.ulejra.ai/c/new')).toBe('https://app.ulejra.ai');
    expect(resolveBackendOrigin('http://localhost:3080')).toBe('http://localhost:3080');
    expect(resolveBackendOrigin('http://127.0.0.1:3080/')).toBe('http://127.0.0.1:3080');
    expect(() => resolveBackendOrigin('http://app.ulejra.ai')).toThrow(UlejraAccountError);
    expect(() => resolveBackendOrigin('not a url')).toThrow(UlejraAccountError);
  });
});

describe('UlejraAccount', () => {
  it('asks the server to email a code', async () => {
    const { account, fetchImpl, secrets } = setup([() => json({ message: 'sent', resendAfterSec: 60, expiresInSec: 600 })]);

    expect(await account.requestCode(' SME@example.com ')).toEqual({ email: 'sme@example.com', resendAfterSec: 60 });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:3080/api/auth/email-code/request');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'sme@example.com' });
    expect(secrets.values.size).toBe(0);
  });

  it('uses the code sent moments ago instead of failing on the resend cooldown', async () => {
    const { account } = setup([
      () => json({ code: 'resend_too_soon', message: 'Wait 42 seconds', retryAfterSec: 42 }, { status: 429 }),
    ]);
    expect(await account.requestCode('sme@example.com')).toEqual({ email: 'sme@example.com', resendAfterSec: 42 });
  });

  it('says so when the server has no email code sign-in', async () => {
    const { account } = setup([() => json({ message: 'Email code sign-in is not enabled.' }, { status: 404 })]);
    await expect(account.requestCode('sme@example.com')).rejects.toMatchObject({ code: 'code_login_unavailable' });
  });

  it('refuses an invalid address without asking the server', async () => {
    const { account, fetchImpl } = setup([]);
    await expect(account.requestCode('not-an-email')).rejects.toMatchObject({ code: 'invalid_email' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('signs in with the code, keeps only the refresh token, and reads the shared balance', async () => {
    const { account, secrets, fetchImpl } = setup([loginOk, () => balance(4_999_976.06)]);

    const status = await account.verifyCode(' sme@example.com ', ' 123456 ');

    expect(status).toEqual({
      signedIn: true,
      backendUrl: 'http://localhost:3080',
      email: 'sme@example.com',
      name: 'Warung Sari',
      remembered: true,
      balance: { tokenCredits: 4_999_976.06, usd: 4.99997606 },
    });
    const [loginUrl, loginInit] = fetchImpl.mock.calls[0];
    expect(loginUrl).toBe('http://localhost:3080/api/auth/email-code/verify');
    expect(JSON.parse(loginInit.body as string)).toEqual({ email: 'sme@example.com', code: '123456' });
    const stored = JSON.parse(secrets.values.get('ulejra-account') ?? '{}');
    expect(stored).toEqual({
      origin: 'http://localhost:3080',
      refreshToken: 'refresh-1',
      email: 'sme@example.com',
      name: 'Warung Sari',
    });
    const [balanceUrl, balanceInit] = fetchImpl.mock.calls[1];
    expect(balanceUrl).toBe('http://localhost:3080/api/balance');
    expect((balanceInit.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
  });

  it('asks for a name for a new address, then creates the account with it', async () => {
    const { account, secrets, fetchImpl } = setup([
      () => json({ nameRequired: true }),
      loginOk,
      () => balance(5_000_000),
    ]);

    expect(await account.verifyCode('new@example.com', '123456')).toEqual({
      signedIn: false,
      nameRequired: true,
      backendUrl: 'http://localhost:3080',
    });
    expect(secrets.values.size).toBe(0);

    expect(await account.verifyCode('new@example.com', '123456', ' Warung Sari ')).toMatchObject({ signedIn: true });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body as string)).toEqual({
      email: 'new@example.com',
      code: '123456',
      name: 'Warung Sari',
    });
  });

  it('refuses two-factor accounts without storing anything', async () => {
    const { account, secrets } = setup([() => json({ twoFAPending: true, tempToken: 't' })]);
    await expect(account.verifyCode('sme@example.com', '123456')).rejects.toMatchObject({ code: 'two_factor_unsupported' });
    expect(secrets.values.size).toBe(0);
  });

  it('passes the server message on a wrong code', async () => {
    const { account } = setup([
      () => json({ code: 'invalid_code', message: 'The code is incorrect or has expired.' }, { status: 400 }),
    ]);
    await expect(account.verifyCode('sme@example.com', '000000')).rejects.toMatchObject({
      code: 'invalid_code',
      message: 'The code is incorrect or has expired.',
    });
  });

  it('refuses a malformed code without asking the server', async () => {
    const { account, fetchImpl } = setup([]);
    await expect(account.verifyCode('sme@example.com', '12ab')).rejects.toMatchObject({ code: 'invalid_code' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('renews an expiring access token with the refresh cookie and keeps a rotated one', async () => {
    const { account, secrets, fetchImpl, advance } = setup([
      loginOk,
      () => balance(5_000_000),
      () => json({ token: jwt(NOW + 30 * 60_000) }, { cookie: 'refreshToken=refresh-2; Path=/api; HttpOnly' }),
    ]);
    await account.verifyCode('sme@example.com', '123456');
    advance(15 * 60_000);

    const token = await account.getAccessToken();

    expect(token).toBe(jwt(NOW + 30 * 60_000));
    const [refreshUrl, refreshInit] = fetchImpl.mock.calls[2];
    expect(refreshUrl).toBe('http://localhost:3080/api/auth/refresh');
    expect((refreshInit.headers as Record<string, string>).cookie).toBe('refreshToken=refresh-1');
    expect(JSON.parse(secrets.values.get('ulejra-account') ?? '{}').refreshToken).toBe('refresh-2');
  });

  it('signs out here when the server no longer accepts the session', async () => {
    const { account, secrets, advance } = setup([
      loginOk,
      () => balance(5_000_000),
      () => new Response('Invalid refresh token', { status: 403 }),
    ]);
    await account.verifyCode('sme@example.com', '123456');
    advance(15 * 60_000);

    await expect(account.getAccessToken()).rejects.toMatchObject({ code: 'signed_out' });
    expect(secrets.values.has('ulejra-account')).toBe(false);
  });

  it('never sends the session to a changed server address', async () => {
    const { account, config, fetchImpl } = setup([loginOk, () => balance(5_000_000)]);
    await account.verifyCode('sme@example.com', '123456');
    config.ulejra.backendUrl = 'https://attacker.example';

    expect(await account.status()).toEqual({ signedIn: false, backendUrl: 'https://attacker.example' });
    await expect(account.authorizedFetch('/api/balance')).rejects.toMatchObject({ code: 'signed_out' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([url]) => String(url).startsWith('http://localhost:3080/'))).toBe(true);
  });

  it('retries a request once with a renewed token after a 401', async () => {
    const { account, fetchImpl } = setup([
      loginOk,
      () => balance(5_000_000),
      () => new Response('', { status: 401 }),
      () => json({ token: jwt(NOW + 30 * 60_000) }),
      () => json({ ok: true }),
    ]);
    await account.verifyCode('sme@example.com', '123456');

    const response = await account.authorizedFetch('/api/ulejra/desktop/chat', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/auth/email-code/verify',
      '/api/balance',
      '/api/ulejra/desktop/chat',
      '/api/auth/refresh',
      '/api/ulejra/desktop/chat',
    ]);
  });

  it('signs out locally and on the server', async () => {
    const { account, secrets, fetchImpl } = setup([loginOk, () => balance(5_000_000), () => json({})]);
    await account.verifyCode('sme@example.com', '123456');

    expect(await account.logout()).toEqual({ signedIn: false, backendUrl: 'http://localhost:3080' });
    expect(secrets.values.size).toBe(0);
    const [logoutUrl, logoutInit] = fetchImpl.mock.calls[2];
    expect(logoutUrl).toBe('http://localhost:3080/api/auth/logout');
    expect((logoutInit.headers as Record<string, string>).cookie).toBe('refreshToken=refresh-1');
  });

  it('keeps the sign-in in memory only when the keychain cannot encrypt it', async () => {
    const { account, secrets } = setup([loginOk, () => balance(5_000_000), () => balance(5_000_000)]);
    secrets.store.set = () => {
      throw new Error('Electron safeStorage encryption is not available');
    };

    const status = await account.verifyCode('sme@example.com', '123456');

    expect(status).toMatchObject({ signedIn: true, remembered: false });
    expect(secrets.values.size).toBe(0);
    expect(await account.status()).toMatchObject({ signedIn: true, remembered: false });
    await account.logout();
    expect(await account.status()).toEqual({ signedIn: false, backendUrl: 'http://localhost:3080' });
  });

  it('reports a server that does not meter usage', async () => {
    const { account } = setup([loginOk, () => new Response(null, { status: 204 })]);
    expect((await account.verifyCode('sme@example.com', '123456')).balance).toBeNull();
  });
});
