import { fork } from 'child_process';
import path from 'path';
import type * as ElectronModuleNs from 'electron';
import { createLogger } from '../../utils/logger';

type ElectronModule = typeof ElectronModuleNs;

const log = createLogger('UlejraEmbedder');

/**
 * Embeddings for the user's documents, computed on this computer.
 *
 * paraphrase-multilingual-MiniLM-L12-v2 (int8, ~120 MB, downloaded once from Hugging Face into
 * `<data>/models` on first use): 50+ languages including Indonesian, and an Indonesian question
 * finds an English passage. It reads about 128 tokens, which is why chunks are ~500 characters.
 */
export const EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

/** Stop the model process after this long without work; it holds ~650 MB. */
const IDLE_MS = 5 * 60_000;
/** After a failed load, keyword search only until this long has passed. */
const RETRY_AFTER_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10 * 60_000;

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

interface Child {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

function spawnChild(script: string, env: Record<string, string>): Child {
  const electron: ElectronModule | null = process.versions.electron
    ? (require('electron') as ElectronModule)
    : null;
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
  model?: string;
  /** The compiled child script; defaults to embedder-process.js next to this file. */
  script?: string;
  now?: () => number;
}

export class ProcessEmbedder implements Embedder {
  readonly model: string;
  private child: Child | null = null;
  private current: EmbedderState = { state: 'idle' };
  private failedAt = 0;
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (vectors: number[][]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
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
    const child = this.ensureChild();
    this.touch();
    const id = this.nextId++;
    const vectors = await new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The document model took too long.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, texts });
    }).catch((error: Error) => {
      this.fail(error.message);
      throw error;
    });
    this.touch();
    return vectors.map((vector) => Float32Array.from(vector));
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.child?.kill();
    this.child = null;
    if (this.current.state !== 'unavailable') this.current = { state: 'idle' };
  }

  private ensureChild(): Child {
    if (this.child) return this.child;
    const script = this.options.script ?? path.join(__dirname, 'embedder-process.js');
    const child = spawnChild(script, {
      ULEJRA_EMBEDDING_MODEL: this.model,
      ULEJRA_EMBEDDING_CACHE: this.options.cacheDir,
    });
    this.current = { state: 'loading' };
    child.onMessage((raw) => {
      const message = raw as {
        id?: number;
        type?: string;
        vectors?: number[][];
        error?: string;
        loaded?: number;
        total?: number;
      };
      if (message.type === 'progress') {
        this.current = { state: 'loading', downloaded: message.loaded, total: message.total };
        return;
      }
      if (message.type === 'ready') {
        this.current = { state: 'ready' };
        return;
      }
      if (typeof message.id !== 'number') return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.vectors ?? []);
    });
    child.onExit((code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.pending.size > 0) {
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error(`The document model stopped (exit ${code}).`));
        }
        this.pending.clear();
      } else if (this.current.state !== 'unavailable') {
        this.current = { state: 'idle' };
      }
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

  private fail(message: string): void {
    log.warn('Document model unavailable, keyword search only:', message);
    this.failedAt = this.now();
    this.current = { state: 'unavailable', error: message };
    this.child?.kill();
    this.child = null;
  }
}
