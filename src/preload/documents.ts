import { ipcRenderer, webUtils } from 'electron';
import { IpcChannels } from '../shared/ipc-channels';

/** My Documents from the chat panel: dropped files go in, sources under answers open. */
export function createDocumentsApi() {
  return {
    /** Adds files or folders the user dropped (File objects from the drop event) to My Documents. */
    addDroppedDocuments: (files: File[]): Promise<{ added: number; skipped: string[] }> => {
      const paths = Array.from(files)
        .map((file) => {
          try {
            return webUtils.getPathForFile(file);
          } catch {
            return '';
          }
        })
        .filter(Boolean);
      return ipcRenderer.invoke(IpcChannels.ULEJRA_DOCUMENTS_ADD, paths);
    },
    openUlejraDocument: (documentId: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IpcChannels.ULEJRA_DOCUMENTS_OPEN, documentId),
  };
}
