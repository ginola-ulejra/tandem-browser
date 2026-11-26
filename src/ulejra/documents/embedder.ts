import { fork } from 'child_process';
import path from 'path';
import type * as ElectronModuleNs from 'electron';
import { createLogger } from '../../utils/logger';

type ElectronModule = typeof ElectronModuleNs;

const log = createLogger('UlejraEmbedder');

/**
 * The local models for the user's documents, run in a separate process on this computer:
 *
 * - Embeddings: paraphrase-multilingual-MiniLM-L12-v2 (int8, ~135 MB, downloaded once from
 *   Hugging Face into `<data>/models` on first use): 50+ languages including Indonesian, and an
 *   Indonesian question finds an English passage. It reads about 128 tokens, which is why chunks
 *   are ~500 characters.
 * - Text recognition (OCR) of scanned PDF pages: Tesseract, Indonesian and English (~7 MB of
 *   language data, downloaded once into `<data>/models/tesseract`). See ocr.ts.
 */
export const EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

/** Stop the model process after this long without work; it holds ~650 MB. */
const IDLE_MS = 5 * 60_000;
/** After a failed load, keyword search only until this long has passed. */
const RETRY_AFTER_MS = 10 * 60_000;
const EMBED_TIMEOUT_MS = 10 * 60_000;
/** OCR requests time out per page, not per document. */
const OCR_PAGE_TIMEOUT_MS = 3 * 60_000;

export type EmbedderState =
  | { state: 'idle' }
  | { state: 'loading'; downloaded?: number; total?: number }
  | { state: 'ready' }
  | { state: 'unavailable'; error: string };

export interface Embedder {
  readonly model: string;
  status(): EmbedderState;
  /** Unit-length vectors, one per text. Throws when the model cannot run here. */
  embed(texts: string[]): Promise<Float32Array[]>;
  dispose(): void;
}

export interface PdfOcr {
  /** Recognized text of the given 1-based pages ('' for a page without a scanned image). */
  ocrPdf(filePath: string, pages: number[], onPage?: (done: number, total: number) => void): Promise<Record<number, string>>;
  /** Recognized text of a photo of a document; '' when it holds no legible text. */
  ocrImage(filePath: string): Promise<string>;
}

interface Child {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

function spawnChild(script: string, env: Record<string, string>): Child {
  const electron: ElectronModule | null = process.versions.electron ? (require('electron') as ElectronModule) : null;
  if (electron?.utilityProcess) {
    const child = electron.utilityProcess.fork(script, [], {
      serviceName: 'Ulejra documents',
      env: { ...process.env, ...env },
      stdio: 'ignore',
    });
    return {
      send: (message) => child.postMessage(message),
      onMessage: (listener) => child.on('message', listener),
      onExit: (listener) => child.on('exit', listener),
      kill: () => child.kill(),
    };
  }
  const child = fork(script, [], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  return {
    send: (message) => child.send(message as never),
    onMessage: (listener) => child.on('message', listener),
    onExit: (listener) => child.on('exit', (code) => listener(code)),
    kill: () => child.kill(),
  };
}

export interface ProcessEmbedderOptions {
  cacheDir: string;
  /** Where Tesseract keeps its language data; defaults to `<cacheDir>/tesseract`. */
  ocrCacheDir?: string;
  model?: string;
  /** The compiled child script; defaults to embedder-process.js next to this file. */
  script?: string;
  now?: () => number;
}

interface Pending {
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  timeoutMs: number;
  onProgress?: (done: number, total: number) => void;
}

export class ProcessEmbedder implements Embedder, PdfOcr {
  readonly model: string;
  private child: Child | null = null;
  private current: EmbedderState = { state: 'idle' };
  private failedAt = 0;
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly now: () => number;

  constructor(private readonly options: ProcessEmbedderOptions) {
    this.model = options.model ?? EMBEDDING_MODEL;
    this.now = options.now ?? Date.now;
  }

  status(): EmbedderState {
    if (this.current.state === 'unavailable' && this.now() - this.failedAt > RETRY_AFTER_MS) {
      return { state: 'idle' };
    }
    return this.current;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (this.current.state === 'unavailable' && this.now() - this.failedAt <= RETRY_AFTER_MS) {
      throw new Error(this.current.error);
    }
    let reply: Record<string, unknown>;
    try {
      reply = await this.request({ texts }, EMBED_TIMEOUT_MS);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      throw error;
    }
    return ((reply.vectors as number[][] | undefined) ?? []).map((vector) => Float32Array.from(vector));
  }

  async ocrPdf(
    filePath: string,
    pages: number[],
    onPage?: (done: number, total: number) => void,
  ): Promise<Record<number, string>> {
    if (pages.length === 0) return {};
    const reply = await this.request({ op: 'ocr', path: filePath, pages }, OCR_PAGE_TIMEOUT_MS, onPage);
    return (reply.pages as Record<number, string> | undefined) ?? {};
  }

  async ocrImage(filePath: string): Promise<string> {
    const reply = await this.request({ op: 'ocr-image', path: filePath }, OCR_PAGE_TIMEOUT_MS);
    return typeof reply.text === 'string' ? reply.text : '';
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.child?.kill();
    this.child = null;
    if (this.current.state !== 'unavailable') this.current = { state: 'idle' };
  }

  /** Sends a request to the model process; the timeout restarts on every progress message. */
  private request(
    body: Record<string, unknown>,
    timeoutMs: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Record<string, unknown>> {
    const child = this.ensureChild();
    this.touch();
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const entry: Pending = {
        resolve,
        reject,
        timeoutMs,
        onProgress,
        timer: setTimeout(() => this.expire(id), timeoutMs),
      };
      this.pending.set(id, entry);
      child.send({ id, ...body });
    }).finally(() => this.touch());
  }

  private expire(id: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.reject(new Error('The document model took too long.'));
  }

  private ensureChild(): Child {
    if (this.child) return this.child;
    const script = this.options.script ?? path.join(__dirname, 'embedder-process.js');
    const child = spawnChild(script, {
      ULEJRA_EMBEDDING_MODEL: this.model,
      ULEJRA_EMBEDDING_CACHE: this.options.cacheDir,
      ULEJRA_OCR_CACHE: this.options.ocrCacheDir ?? path.join(this.options.cacheDir, 'tesseract'),
    });
    if (this.current.state !== 'ready') this.current = { state: 'idle' };
    child.onMessage((raw) => {
      const message = raw as Record<string, unknown> & { id?: number; type?: string };
      if (message.type === 'progress') {
        this.current = {
          state: 'loading',
          downloaded: message.loaded as number | undefined,
          total: message.total as number | undefined,
        };
        return;
      }
      if (message.type === 'ready') {
        this.current = { state: 'ready' };
        return;
      }
      if (typeof message.id !== 'number') return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      if (message.type === 'ocr-progress') {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.expire(message.id as number), entry.timeoutMs);
        entry.onProgress?.(Number(message.done), Number(message.total));
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (typeof message.error === 'string') entry.reject(new Error(message.error));
      else entry.resolve(message);
    });
    child.onExit((code) => {
      if (this.child !== child) return;
      this.child = null;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`The document model stopped (exit ${code}).`));
      }
      this.pending.clear();
      if (this.current.state !== 'unavailable') this.current = { state: 'idle' };
    });
    this.child = child;
    return child;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.dispose();
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  /** Meaning search is off for a while; OCR is unaffected. */
  private fail(message: string): void {
    log.warn('Document model unavailable, keyword search only:', message);
    this.failedAt = this.now();
    this.current = { state: 'unavailable', error: message };
    if (this.pending.size === 0) {
      this.child?.kill();
      this.child = null;
    }
  }
}
