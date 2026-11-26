import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const showOpenDialog = vi.fn();
vi.mock('electron', () => ({
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) },
  BrowserWindow: Object.assign(vi.fn(), {
    getFocusedWindow: vi.fn(() => ({ id: 1 })),
    getAllWindows: vi.fn(() => [{ id: 1 }]),
  }),
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

  describe('My Documents', () => {
    it('reports the library status', async () => {
      const res = await request(app).get('/integrations/ulejra/documents');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, sources: [], indexing: false, model: { state: 'idle' } });
    });

    it('adds what the user picks in the file dialog', async () => {
      showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/Users/me/Docs'] });
      vi.mocked(ctx.ulejraDocuments.add).mockResolvedValueOnce({ added: 1, skipped: [] });
      const res = await request(app).post('/integrations/ulejra/documents/add').send({ kind: 'folder' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, added: 1 });
      expect(showOpenDialog.mock.calls[0][1]).toMatchObject({ properties: ['openDirectory'] });
      expect(ctx.ulejraDocuments.add).toHaveBeenCalledWith(['/Users/me/Docs']);
    });

    it('adds nothing when the dialog is canceled', async () => {
      showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
      const res = await request(app).post('/integrations/ulejra/documents/add').send({ kind: 'files' });
      expect(res.body).toMatchObject({ ok: true, canceled: true });
      expect(ctx.ulejraDocuments.add).not.toHaveBeenCalled();
    });

    it('refreshes and removes', async () => {
      expect((await request(app).post('/integrations/ulejra/documents/refresh')).status).toBe(200);
      expect(ctx.ulejraDocuments.refresh).toHaveBeenCalled();
      expect((await request(app).delete('/integrations/ulejra/documents/sources/3')).status).toBe(200);
      expect(ctx.ulejraDocuments.remove).toHaveBeenCalledWith(3);
      vi.mocked(ctx.ulejraDocuments.remove).mockReturnValueOnce(false);
      expect((await request(app).delete('/integrations/ulejra/documents/sources/9')).status).toBe(404);
      expect((await request(app).delete('/integrations/ulejra/documents/sources/abc')).status).toBe(404);
    });

    it('offers no search route, and refuses paired remote agents', async () => {
      expect((await request(app).post('/integrations/ulejra/documents/search').send({ query: 'x' })).status).toBe(404);
      const remote = express();
      remote.use(express.json());
      remote.use((_req, res, next) => {
        res.locals.apiCaller = { kind: 'paired-agent' };
        next();
      });
      const router = express.Router();
      registerUlejraRoutes(router, ctx);
      remote.use(router);
      for (const call of [
        request(remote).get('/integrations/ulejra/documents'),
        request(remote).post('/integrations/ulejra/documents/add').send({ kind: 'files' }),
        request(remote).post('/integrations/ulejra/documents/refresh'),
        request(remote).delete('/integrations/ulejra/documents/sources/1'),
      ]) {
        expect((await call).status).toBe(403);
      }
      expect(showOpenDialog).not.toHaveBeenCalled();
      expect(ctx.ulejraDocuments.status).not.toHaveBeenCalled();
    });
  });
});
