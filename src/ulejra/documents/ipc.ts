import path from 'path';
import { ipcMain, shell } from 'electron';
import type { PanelManager } from '../../panel/manager';
import { IpcChannels } from '../../shared/ipc-channels';
import type { DocumentLibrary } from './library';

/**
 * My Documents from the chat panel: files and folders the user drops on the chat are added, and a
 * source under an answer opens its file. Only the app's own window calls these (IPC from the
 * preload, with paths from the user's own drop), unlike the local HTTP API.
 */

const ACTOR_LABEL = 'Ulejra';
const NOTICE_TYPE = 'ulejra-notice';

export interface DocumentsIpcDeps {
  library: DocumentLibrary;
  panelManager: PanelManager;
  /** Opens a file with its default app; returns '' or an error message (Electron's shell.openPath). */
  openPath?: (filePath: string) => Promise<string>;
}

function notice(panelManager: PanelManager, text: string): void {
  panelManager.addChatMessage('wingman', text, undefined, {
    actorLabel: ACTOR_LABEL,
    agentType: NOTICE_TYPE,
    notifyWebhook: false,
  });
}

/** What the chat says after a drop. */
export function describeAdded(paths: string[], result: { added: number; skipped: string[] }): string {
  const skipped = new Set(result.skipped);
  const added = paths.filter((p) => !skipped.has(path.resolve(p))).map((p) => path.basename(p));
  const parts: string[] = [];
  if (added.length) {
    const names = added.length <= 3 ? added.join(', ') : `${added.slice(0, 3).join(', ')} and ${added.length - 3} more`;
    parts.push(
      `Added ${names} to My Documents. They are read on this computer; ask me about them in a moment (Settings → My Documents shows the progress).`,
    );
  }
  if (result.skipped.length) {
    parts.push(
      `Not added: ${result.skipped.map((p) => path.basename(p)).join(', ')} (only PDF, Word, text, Markdown, CSV, JSON and photos).`,
    );
  }
  return parts.join(' ');
}

export async function addDropped(deps: DocumentsIpcDeps, raw: unknown): Promise<{ added: number; skipped: string[] }> {
  const paths = Array.isArray(raw)
    ? raw.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)).slice(0, 50)
    : [];
  if (paths.length === 0) return { added: 0, skipped: [] };
  const result = await deps.library.add(paths);
  const text = describeAdded(paths, result);
  if (text) notice(deps.panelManager, text);
  return result;
}

export async function openSource(deps: DocumentsIpcDeps, documentId: unknown): Promise<{ ok: boolean; error?: string }> {
  // Only files in My Documents: an id the index does not know opens nothing.
  const filePath = Number.isInteger(documentId) ? deps.library.documentPath(documentId as number) : null;
  if (!filePath) return { ok: false, error: 'This document is no longer in My Documents.' };
  const error = await (deps.openPath ?? ((p) => shell.openPath(p)))(filePath);
  return error ? { ok: false, error } : { ok: true };
}

export function registerDocumentsIpc(deps: DocumentsIpcDeps): void {
  ipcMain.removeHandler(IpcChannels.ULEJRA_DOCUMENTS_ADD);
  ipcMain.removeHandler(IpcChannels.ULEJRA_DOCUMENTS_OPEN);
  ipcMain.handle(IpcChannels.ULEJRA_DOCUMENTS_ADD, (_event, paths: unknown) => addDropped(deps, paths));
  ipcMain.handle(IpcChannels.ULEJRA_DOCUMENTS_OPEN, (_event, documentId: unknown) => openSource(deps, documentId));
}
