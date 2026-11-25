import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  session: {},
  webContents: {
    fromId: vi.fn(),
    getAllWebContents: vi.fn().mockReturnValue([]),
  },
}));

import { registerUlejraRoutes } from '../../routes/ulejra';
import { UlejraAccountError } from '../../../ulejra/account';
import { createMockContext, createTestApp } from '../helpers';
import type { RouteContext } from '../../context';

describe('Ulejra account routes', () => {
  let ctx: RouteContext;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockContext();
    app = createTestApp(registerUlejraRoutes, ctx);
  });

  it('reports the account status', async () => {
    vi.mocked(ctx.ulejraAccount.status).mockResolvedValue({
      signedIn: true,
      backendUrl: 'http://localhost:3080',
      email: 'sme@example.com',
      balance: { tokenCredits: 5_000_000, usd: 5 },
    });
    const res = await request(app).get('/integrations/ulejra/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ signedIn: true, balance: { usd: 5 } });
  });

  it('signs in with the email and password from the body', async () => {
    vi.mocked(ctx.ulejraAccount.login).mockResolvedValue({
      signedIn: true,
      backendUrl: 'http://localhost:3080',
      email: 'sme@example.com',
    });
    const res = await request(app)
      .post('/integrations/ulejra/login')
      .send({ email: 'sme@example.com', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, signedIn: true });
    expect(ctx.ulejraAccount.login).toHaveBeenCalledWith('sme@example.com', 'pw');
  });

  it('answers a wrong password with 400, never 401 (401 means the local API token)', async () => {
    vi.mocked(ctx.ulejraAccount.login).mockRejectedValue(
      new UlejraAccountError('invalid_credentials', 'Email or password is incorrect'),
    );
    const res = await request(app)
      .post('/integrations/ulejra/login')
      .send({ email: 'sme@example.com', password: 'wrong' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, code: 'invalid_credentials', error: 'Email or password is incorrect' });
  });

  it('answers 502 when the Ulejra server cannot be reached', async () => {
    vi.mocked(ctx.ulejraAccount.login).mockRejectedValue(
      new UlejraAccountError('backend_unreachable', 'Could not reach the Ulejra server.'),
    );
    const res = await request(app)
      .post('/integrations/ulejra/login')
      .send({ email: 'sme@example.com', password: 'pw' });
    expect(res.status).toBe(502);
  });

  it('signs out', async () => {
    const res = await request(app).post('/integrations/ulejra/logout');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, signedIn: false });
  });
});
