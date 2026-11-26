import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../../utils/logger';
import type { Embedder, EmbedderState } from './embedder';
import { chunkText, extractText, isSupportedFile, MAX_FILE_BYTES } from './extract';
import type { DocumentStore, SourceKind, SourceSummary } from './store';

const log = createLogger('UlejraDocuments');

/**
 * "My Documents" for the Ulejra assistant: files and folders the user adds on this computer, read
 * and indexed here, and searched here when the assistant asks. Nothing is uploaded: only the
 * passages a search returns go to the model with the user's question.
 */

/** Files found in one folder, at most; deeper or further files are left out. */
export const MAX_FILES_PER_FOLDER = 2_000;
const MAX_DEPTH = 8;
const EMBED_BATCH = 16;
/** Results from each ranking that are combined. */
const CANDIDATES = 30;
/** Reciprocal rank fusion constant. */
const RRF_K = 60;

const SKIPPED_DIRS = new Set(['node_modules', '__pycache__', '$RECYCLE.BIN', 'System Volume Information']);

export interface DocumentSearchResult {
  name: string;
  path: string;
  page: number | null;
  text: string;
}

export interface DocumentLibraryStatus {
  sources: Array<
    Pick<SourceSummary, 'id' | 'path' | 'kind' | 'documents' | 'ready' | 'pending' | 'errors' | 'firstError'> & {
      name: string;
    }
  >;
  totals: { documents: number; ready: number; pending: number; chunks: number; embedded: number };
  indexing: boolean;
  /** Smart (meaning-based) search; keyword search works without it. */
  model: EmbedderState;
}

export interface DocumentLibraryOptions {
  store: DocumentStore;
  embedder: Embedder;
  now?: () => number;
}

export class DocumentLibrary {
  private readonly store: DocumentStore;
  private readonly embedder: Embedder;
  private readonly now: () => number;
  private working: Promise<void> | null = null;
  private again = false;

  constructor(options: DocumentLibraryOptions) {
    this.store = options.store;
    this.embedder = options.embedder;
    this.now = options.now ?? Date.now;
    this.store.useEmbeddingModel(this.embedder.model);
    this.store.resetInterrupted();
  }

  /** Picks up work left from the last run (pending documents, missing embeddings). */
  start(): void {
    this.kick();
  }

  /** Adds files and folders and indexes them in the background. Returns the paths skipped. */
  async add(paths: string[]): Promise<{ added: number; skipped: string[] }> {
    let added = 0;
    const skipped: string[] = [];
    for (const raw of paths) {
      const target = path.resolve(raw);
      const stat = await fs.stat(target).catch(() => null);
      if (stat?.isDirectory()) {
        const source = this.store.addSource(target, 'folder', this.now());
        await this.scanFolder(source.id, target);
        added++;
      } else if (stat?.isFile() && isSupportedFile(target)) {
        const source = this.store.addSource(target, 'file', this.now());
        this.store.upsertDocument({
          sourceId: source.id,
          path: target,
          name: path.basename(target),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
        added++;
      } else {
        skipped.push(target);
      }
    }
    this.kick();
    return { added, skipped };
  }

  /** Looks for new, changed and deleted files in everything added. */
  async refresh(): Promise<void> {
    for (const source of this.store.listSources()) {
      if (source.kind === 'folder') {
        await this.scanFolder(source.id, source.path);
      } else {
        const stat = await fs.stat(source.path).catch(() => null);
        if (stat?.isFile()) {
          this.store.upsertDocument({
            sourceId: source.id,
            path: source.path,
            name: path.basename(source.path),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        } else {
          this.store.pruneDocuments(source.id, new Set());
        }
      }
    }
    this.kick();
  }

  remove(sourceId: number): boolean {
    return this.store.removeSource(sourceId);
  }

  hasDocuments(): boolean {
    return this.store.counts().ready > 0;
  }

  status(): DocumentLibraryStatus {
    return {
      sources: this.store.summaries().map((source) => ({
        id: source.id,
        path: source.path,
        kind: source.kind,
        name: path.basename(source.path) || source.path,
        documents: source.documents,
        ready: source.ready,
        pending: source.pending,
        errors: source.errors,
        firstError: source.firstError,
      })),
      totals: this.store.counts(),
      indexing: this.working !== null,
      model: this.embedder.status(),
    };
  }

  /**
   * The passages that best answer `query`: keyword matches (BM25) and, when the model runs here,
   * passages close in meaning, combined by reciprocal rank fusion.
   */
  async search(query: string, limit = 5): Promise<DocumentSearchResult[]> {
    const text = query.trim();
    if (!text) return [];
    const rankings: number[][] = [this.store.keywordSearch(text, CANDIDATES)];
    if (this.store.counts().embedded > 0) {
      try {
        const [vector] = await this.embedder.embed([text]);
        if (vector) rankings.push(this.store.vectorSearch(vector, CANDIDATES));
      } catch (error) {
        log.warn('Meaning search unavailable, keyword results only:', error instanceof Error ? error.message : String(error));
      }
    }
    const scores = new Map<number, number>();
    for (const ranking of rankings) {
      ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
    }
    const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const hits = this.store.getChunks(ordered.slice(0, limit * 3));
    // One passage per spot in a document: skip a chunk that directly follows one already taken.
    const taken = new Set<string>();
    const results: DocumentSearchResult[] = [];
    for (const hit of hits) {
      if (results.length >= limit) break;
      if (taken.has(`${hit.documentId}:${hit.ord - 1}`) || taken.has(`${hit.documentId}:${hit.ord}`)) continue;
      taken.add(`${hit.documentId}:${hit.ord}`);
      taken.add(`${hit.documentId}:${hit.ord + 1}`);
      const next = this.store.nextChunkText(hit.documentId, hit.ord);
      results.push({ name: hit.name, path: hit.path, page: hit.page, text: next ? `${hit.text}\n${next}` : hit.text });
    }
    return results;
  }

  /** Stops the model process and closes the index (app quit). */
  dispose(): void {
    this.embedder.dispose();
    this.store.close();
  }

  /** Resolves when the background indexing in progress (if any) is done. For tests. */
  async idle(): Promise<void> {
    while (this.working) await this.working;
  }

  private async scanFolder(sourceId: number, root: string): Promise<void> {
    const found = new Set<string>();
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || found.size >= MAX_FILES_PER_FOLDER) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (found.size >= MAX_FILES_PER_FOLDER) return;
        if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name)) await walk(full, depth + 1);
        } else if (entry.isFile() && isSupportedFile(full)) {
          const stat = await fs.stat(full).catch(() => null);
          if (!stat || stat.size > MAX_FILE_BYTES) continue;
          found.add(full);
          this.store.upsertDocument({ sourceId, path: full, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      }
    };
    await walk(root, 0);
    this.store.pruneDocuments(sourceId, found);
  }

  /** Starts the background worker, or asks the running one to look again when it is done. */
  private kick(): void {
    if (this.working) {
      this.again = true;
      return;
    }
    this.working = this.work()
      .catch((error) => log.warn('Indexing stopped:', error instanceof Error ? error.message : String(error)))
      .finally(() => {
        this.working = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  private async work(): Promise<void> {
    // Read every pending document first, so keyword search covers them all quickly.
    for (let doc = this.store.takePending(); doc; doc = this.store.takePending()) {
      try {
        const extracted = await extractText(doc.path);
        const chunks = chunkText(extracted, path.extname(doc.path).toLowerCase() === '.pdf');
        if (chunks.length === 0) {
          this.store.markError(doc.id, 'No text found (a scan or photo needs text recognition, which is not supported yet).');
        } else {
          this.store.saveChunks(doc.id, chunks);
        }
      } catch (error) {
        this.store.markError(doc.id, error instanceof Error ? error.message : String(error));
      }
    }
    // Then embeddings, in batches; without the model, keyword search still works.
    for (let batch = this.store.chunksWithoutEmbedding(EMBED_BATCH); batch.length; batch = this.store.chunksWithoutEmbedding(EMBED_BATCH)) {
      let vectors: Float32Array[];
      try {
        vectors = await this.embedder.embed(batch.map((chunk) => chunk.text));
      } catch (error) {
        log.warn('Embeddings postponed:', error instanceof Error ? error.message : String(error));
        return;
      }
      this.store.saveEmbeddings(batch.map((chunk, i) => ({ id: chunk.id, vector: vectors[i] })));
      // New documents added meanwhile are read before more embeddings.
      if (this.again && this.store.counts().pending > 0) return;
    }
  }
}

export type { SourceKind };
