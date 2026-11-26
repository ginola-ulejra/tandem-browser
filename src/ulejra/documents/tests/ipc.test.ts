import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, shell: { openPath: vi.fn() } }));

import { addDropped, describeAdded, openSource, type DocumentsIpcDeps } from '../ipc';

function deps(overrides: Partial<{ add: unknown; documentPath: unknown; openPath: unknown }> = {}) {
  const panelManager = { addChatMessage: vi.fn() };
  const library = {
    add: overrides.add ?? vi.fn(async (paths: string[]) => ({ added: paths.length, skipped: [] as string[] })),
    documentPath: overrides.documentPath ?? vi.fn((id: number) => (id === 3 ? '/Users/me/Docs/kontrak.pdf' : null)),
  };
  const openPath = (overrides.openPath ?? vi.fn(async () => '')) as DocumentsIpcDeps['openPath'];
  return {
    panelManager,
    library,
    openPath,
    value: { library, panelManager, openPath } as unknown as DocumentsIpcDeps,
  };
}

describe('My Documents from the chat panel', () => {
  it('adds dropped files and folders and says so in the chat', async () => {
    const d = deps();
    const result = await addDropped(d.value, ['/Users/me/Docs/kontrak.pdf', '/Users/me/Laporan', 42, 'relative.txt']);
    expect(d.library.add).toHaveBeenCalledWith(['/Users/me/Docs/kontrak.pdf', '/Users/me/Laporan']);
    expect(result.added).toBe(2);
    const [from, text, , opts] = d.panelManager.addChatMessage.mock.calls[0];
    expect(from).toBe('wingman');
    expect(text).toMatch(/^Added kontrak\.pdf, Laporan to My Documents\./);
    expect(opts).toMatchObject({ agentType: 'ulejra-notice', notifyWebhook: false });
  });

  it('names what it skipped, and ignores an empty drop', async () => {
    expect(describeAdded(['/a/x.pdf', '/a/y.zip'], { added: 1, skipped: [path.resolve('/a/y.zip')] })).toBe(
      'Added x.pdf to My Documents. They are read on this computer; ask me about them in a moment (Settings → My Documents shows the progress). Not added: y.zip (only PDF, Word, text, Markdown, CSV, JSON and photos).',
    );
    const d = deps();
    expect(await addDropped(d.value, 'not a list')).toEqual({ added: 0, skipped: [] });
    expect(d.library.add).not.toHaveBeenCalled();
    expect(d.panelManager.addChatMessage).not.toHaveBeenCalled();
  });

  it('opens only documents that are in My Documents', async () => {
    const d = deps();
    expect(await openSource(d.value, 3)).toEqual({ ok: true });
    expect(d.openPath).toHaveBeenCalledWith('/Users/me/Docs/kontrak.pdf');
    expect(await openSource(d.value, 7)).toEqual({ ok: false, error: 'This document is no longer in My Documents.' });
    expect(await openSource(d.value, '../etc/passwd')).toMatchObject({ ok: false });
    expect(d.openPath).toHaveBeenCalledTimes(1);
  });

  it('passes on an error from opening the file', async () => {
    const d = deps({ openPath: vi.fn(async () => 'No application knows how to open this file') });
    expect(await openSource(d.value, 3)).toEqual({ ok: false, error: 'No application knows how to open this file' });
  });
});
