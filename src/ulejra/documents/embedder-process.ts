import { ocrImageFile, ocrPdfPages, stopOcr } from './ocr';

/**
 * Child process for the heavy local work on the user's documents, on this computer: embeddings
 * with a small multilingual model, and text recognition (OCR) of scanned PDF pages.
 * Started by `ProcessEmbedder` (Electron utilityProcess in the app, child_process.fork elsewhere).
 *
 * Messages in:  { id, texts }                    -> out: { id, vectors: number[][] } | { id, error }
 *               { id, op: 'ocr', path, pages }   -> out: { id, pages: { [page]: text } } | { id, error }
 *               { id, op: 'ocr-image', path }    -> out: { id, text } | { id, error }
 * Messages out: { type: 'progress', loaded, total } while the model downloads (first use only),
 *               { type: 'ready' } once the model is loaded,
 *               { type: 'ocr-progress', id, done, total } after each recognized page.
 */

interface Port {
  on(event: 'message', listener: (message: unknown) => void): void;
  postMessage(message: unknown): void;
}

type ElectronProcess = NodeJS.Process & { parentPort?: { on(e: 'message', l: (m: { data: unknown }) => void): void; postMessage(m: unknown): void } };

function connect(): Port {
  const electronPort = (process as ElectronProcess).parentPort;
  if (electronPort) {
    return {
      on: (_event, listener) => electronPort.on('message', (message) => listener(message.data)),
      postMessage: (message) => electronPort.postMessage(message),
    };
  }
  return {
    on: (_event, listener) => process.on('message', listener),
    postMessage: (message) => process.send?.(message),
  };
}

const port = connect();
const modelId = process.env.ULEJRA_EMBEDDING_MODEL ?? '';
const cacheDir = process.env.ULEJRA_EMBEDDING_CACHE ?? '';
const ocrCacheDir = process.env.ULEJRA_OCR_CACHE ?? '';

type Extractor = (texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

let extractor: Promise<Extractor> | null = null;

function load(): Promise<Extractor> {
  extractor ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    const files = new Map<string, { loaded: number; total: number }>();
    const pipe = await pipeline('feature-extraction', modelId, {
      dtype: 'q8',
      progress_callback: (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (info.status !== 'progress' || !info.file) return;
        files.set(info.file, { loaded: info.loaded ?? 0, total: info.total ?? 0 });
        let loaded = 0;
        let total = 0;
        for (const entry of files.values()) {
          loaded += entry.loaded;
          total += entry.total;
        }
        port.postMessage({ type: 'progress', loaded, total });
      },
    });
    port.postMessage({ type: 'ready' });
    return pipe as unknown as Extractor;
  })();
  return extractor;
}

port.on('message', (raw) => {
  const message = raw as { id?: number; texts?: unknown; op?: string; path?: unknown; pages?: unknown };
  if (typeof message?.id !== 'number') return;
  const { id } = message;
  if (message.op === 'ocr-image') {
    void (async () => {
      try {
        port.postMessage({ id, text: await ocrImageFile(String(message.path), ocrCacheDir) });
      } catch (error) {
        port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return;
  }
  if (message.op === 'ocr') {
    void (async () => {
      try {
        const pages = Array.isArray(message.pages) ? message.pages.filter((p): p is number => Number.isInteger(p)) : [];
        const text = await ocrPdfPages(String(message.path), pages, ocrCacheDir, (done, total) =>
          port.postMessage({ type: 'ocr-progress', id, done, total }),
        );
        port.postMessage({ id, pages: text });
      } catch (error) {
        port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return;
  }
  void (async () => {
    try {
      const texts = Array.isArray(message.texts) ? message.texts.map(String) : [];
      const run = await load();
      const vectors = texts.length ? (await run(texts, { pooling: 'mean', normalize: true })).tolist() : [];
      port.postMessage({ id, vectors });
    } catch (error) {
      extractor = null;
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});

process.on('exit', () => {
  void stopOcr();
});
