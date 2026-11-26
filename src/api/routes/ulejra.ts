import type { Router, Request, Response } from 'express';
import type { RouteContext } from '../context';
import { handleRouteError } from '../../utils/errors';
import { createRateLimitMiddleware } from '../rate-limit';
import { UlejraAccountError, type UlejraAccountErrorCode } from '../../ulejra/account';

/**
 * Ulejra account routes for the Settings page. Errors never use 401: on this API a 401 means the
 * local API token was refused, and the shell would treat it that way.
 */
const STATUS_FOR: Record<UlejraAccountErrorCode, number> = {
  invalid_backend_url: 400,
  invalid_email: 400,
  invalid_code: 400,
  invalid_name: 400,
  code_login_unavailable: 400,
  two_factor_unsupported: 400,
  rate_limited: 429,
  backend_unreachable: 502,
  signed_out: 409,
};

function sendAccountError(res: Response, error: unknown): void {
  if (error instanceof UlejraAccountError) {
    res.status(STATUS_FOR[error.code]).json({ ok: false, code: error.code, error: error.message });
    return;
  }
  handleRouteError(res, error);
}

export function registerUlejraRoutes(router: Router, ctx: RouteContext): void {
  router.get('/integrations/ulejra/status', async (_req: Request, res: Response) => {
    try {
      res.json(await ctx.ulejraAccount.status());
    } catch (e) {
      sendAccountError(res, e);
    }
  });

  /** Passwordless: the Ulejra server emails a code, which signs in or creates the account. */
  router.post('/integrations/ulejra/code/request', createRateLimitMiddleware({
    bucket: 'ulejra-code-request',
    windowMs: 60_000,
    max: 5,
    message: 'Too many codes requested. Try again in a minute.',
  }), async (req: Request, res: Response) => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email : '';
      res.json({ ok: true, ...(await ctx.ulejraAccount.requestCode(email)) });
    } catch (e) {
      sendAccountError(res, e);
    }
  });

  router.post('/integrations/ulejra/code/verify', createRateLimitMiddleware({
    bucket: 'ulejra-code-verify',
    windowMs: 60_000,
    max: 10,
    message: 'Too many sign-in attempts. Try again in a minute.',
  }), async (req: Request, res: Response) => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email : '';
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const name = typeof req.body?.name === 'string' ? req.body.name : undefined;
      res.json({ ok: true, ...(await ctx.ulejraAccount.verifyCode(email, code, name)) });
    } catch (e) {
      sendAccountError(res, e);
    }
  });

  // ── My Documents: the user's files, indexed on this computer for the Ulejra assistant ──
  // Management only: searching is not exposed here, so nothing on this API can read the documents.
  // Paired (remote) agents get no access at all; adding files needs the user's own file dialog.
  const documentsAllowed = (res: Response): boolean => {
    if ((res.locals.apiCaller as { kind?: string } | undefined)?.kind === 'paired-agent') {
      res.status(403).json({ ok: false, error: 'My Documents is only available in the Ulejra app on this computer.' });
      return false;
    }
    return true;
  };

  router.get('/integrations/ulejra/documents', (_req: Request, res: Response) => {
    if (!documentsAllowed(res)) return;
    try {
      res.json({ ok: true, ...ctx.ulejraDocuments.status() });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.post('/integrations/ulejra/documents/add', async (req: Request, res: Response) => {
    if (!documentsAllowed(res)) return;
    try {
      const kind = req.body?.kind === 'folder' ? 'folder' : 'files';
      const { dialog, BrowserWindow } = await import('electron');
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!win) {
        res.status(422).json({ ok: false, error: 'Adding documents needs the Ulejra window.' });
        return;
      }
      const picked = await dialog.showOpenDialog(win, {
        title: kind === 'folder' ? 'Add a folder to My Documents' : 'Add files to My Documents',
        properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
        ...(kind === 'files'
          ? { filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown', 'csv', 'json'] }] }
          : {}),
      });
      if (picked.canceled || picked.filePaths.length === 0) {
        res.json({ ok: true, canceled: true, ...ctx.ulejraDocuments.status() });
        return;
      }
      const result = await ctx.ulejraDocuments.add(picked.filePaths);
      res.json({ ok: true, ...result, ...ctx.ulejraDocuments.status() });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.post('/integrations/ulejra/documents/refresh', async (_req: Request, res: Response) => {
    if (!documentsAllowed(res)) return;
    try {
      await ctx.ulejraDocuments.refresh();
      res.json({ ok: true, ...ctx.ulejraDocuments.status() });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.delete('/integrations/ulejra/documents/sources/:id', (req: Request, res: Response) => {
    if (!documentsAllowed(res)) return;
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || !ctx.ulejraDocuments.remove(id)) {
        res.status(404).json({ ok: false, error: 'Not found.' });
        return;
      }
      res.json({ ok: true, ...ctx.ulejraDocuments.status() });
    } catch (e) {
      handleRouteError(res, e);
    }
  });

  router.post('/integrations/ulejra/logout', async (_req: Request, res: Response) => {
    try {
      res.json({ ok: true, ...(await ctx.ulejraAccount.logout()) });
    } catch (e) {
      sendAccountError(res, e);
    }
  });
}
