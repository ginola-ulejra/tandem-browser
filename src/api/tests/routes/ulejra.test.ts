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

  it('asks the Ulejra server to email a code', async () => {
    vi.mocked(ctx.ulejraAccount.requestCode).mockResolvedValue({ email: 'sme@example.com', resendAfterSec: 60 });
    const res = await request(app).post('/integrations/ulejra/code/request').send({ email: 'sme@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, email: 'sme@example.com', resendAfterSec: 60 });
    expect(ctx.ulejraAccount.requestCode).toHaveBeenCalledWith('sme@example.com');
  });

  it('signs in with the emailed code', async () => {
    vi.mocked(ctx.ulejraAccount.verifyCode).mockResolvedValue({
      signedIn: true,
      backendUrl: 'http://localhost:3080',
      email: 'sme@example.com',
    });
    const res = await request(app)
      .post('/integrations/ulejra/code/verify')
      .send({ email: 'sme@example.com', code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, signedIn: true });
    expect(ctx.ulejraAccount.verifyCode).toHaveBeenCalledWith('sme@example.com', '123456', undefined);
  });

  it('passes the name on to create an account', async () => {
    vi.mocked(ctx.ulejraAccount.verifyCode).mockResolvedValue({
      signedIn: false,
      nameRequired: true,
      backendUrl: 'http://localhost:3080',
    });
    const res = await request(app)
      .post('/integrations/ulejra/code/verify')
      .send({ email: 'new@example.com', code: '123456', name: 'Warung Sari' });
    expect(res.body).toMatchObject({ ok: true, nameRequired: true });
    expect(ctx.ulejraAccount.verifyCode).toHaveBeenCalledWith('new@example.com', '123456', 'Warung Sari');
  });

  it('answers a wrong code with 400, never 401 (401 means the local API token)', async () => {
    vi.mocked(ctx.ulejraAccount.verifyCode).mockRejectedValue(
      new UlejraAccountError('invalid_code', 'The code is incorrect or has expired.'),
    );
    const res = await request(app)
      .post('/integrations/ulejra/code/verify')
      .send({ email: 'sme@example.com', code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, code: 'invalid_code', error: 'The code is incorrect or has expired.' });
  });

  it('answers 502 when the Ulejra server cannot be reached', async () => {
    vi.mocked(ctx.ulejraAccount.requestCode).mockRejectedValue(
      new UlejraAccountError('backend_unreachable', 'Could not reach the Ulejra server.'),
    );
    const res = await request(app).post('/integrations/ulejra/code/request').send({ email: 'sme@example.com' });
    expect(res.status).toBe(502);
  });

  it('signs out', async () => {
    const res = await request(app).post('/integrations/ulejra/logout');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, signedIn: false });
  });
});
