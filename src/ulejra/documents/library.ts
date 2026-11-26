import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../../utils/logger';
import type { Embedder, EmbedderState, PdfOcr } from './embedder';
import { chunkText, extractText, isImageFile, isSupportedFile, MAX_FILE_BYTES, type ExtractedText } from './extract';
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
/** A PDF page with less text than this is treated as scanned and read with text recognition. */
export const SCANNED_PAGE_CHARS = 50;
/** Pages read with text recognition per document, at most (about a second each). */
export const MAX_OCR_PAGES = 500;
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
    Pick<
      SourceSummary,
      'id' | 'path' | 'kind' | 'documents' | 'ready' | 'pending' | 'errors' | 'noText' | 'includeImages' | 'firstError'
    > & {
      name: string;
    }
  >;
  totals: { documents: number; ready: number; pending: number; ocr: number; chunks: number; embedded: number };
  indexing: boolean;
  /** The scanned PDF being read with text recognition right now. */
  ocr: { name: string; done: number; total: number } | null;
  /** Smart (meaning-based) search; keyword search works without it. */
  model: EmbedderState;
}

export interface DocumentLibraryOptions {
  store: DocumentStore;
  embedder: Embedder;
  /** Text recognition for scanned PDF pages; without it those pages are not indexed. */
  ocr?: PdfOcr;
  now?: () => number;
}

export class DocumentLibrary {
  private readonly store: DocumentStore;
  private readonly embedder: Embedder;
  private readonly ocr: PdfOcr | undefined;
  private ocrProgress: { name: string; done: number; total: number } | null = null;
  private readonly now: () => number;
  private working: Promise<void> | null = null;
  private again = false;

  constructor(options: DocumentLibraryOptions) {
    this.store = options.store;
    this.embedder = options.embedder;
    this.ocr = options.ocr;
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
        await this.scanFolder(source.id, target, source.includeImages);
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
        await this.scanFolder(source.id, source.path, source.includeImages);
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

  /**
   * Whether a folder's photos are read too. Off by default, so a folder of holiday pictures is not
   * run through text recognition by accident. Returns false for an unknown id or a file.
   */
  async setIncludeImages(sourceId: number, include: boolean): Promise<boolean> {
    const source = this.store.getSource(sourceId);
    if (!source || source.kind !== 'folder' || !this.store.setIncludeImages(sourceId, include)) return false;
    await this.scanFolder(source.id, source.path, include);
    this.kick();
    return true;
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
        noText: source.noText,
        includeImages: source.includeImages,
        firstError: source.firstError,
      })),
      totals: this.store.counts(),
      indexing: this.working !== null,
      ocr: this.ocrProgress,
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

  /** Finds the folder's documents (and photos when `includeImages`); forgets files no longer found. */
  private async scanFolder(sourceId: number, root: string, includeImages: boolean): Promise<void> {
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
        } else if (entry.isFile() && isSupportedFile(full) && (includeImages || !isImageFile(full))) {
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
    for (;;) {
      // Documents with text first, so keyword search covers them quickly; then their embeddings.
      await this.readPending();
      await this.embedMissing();
      // Then scanned PDFs, one at a time, each searchable as soon as it is read.
      const doc = this.store.takeOcr();
      if (!doc) return;
      await this.recognize(doc);
    }
  }

  /** 1-based numbers of the PDF pages that look scanned (no text layer to speak of). */
  private scannedPages(extracted: ExtractedText): number[] {
    return extracted.pages
      .map((text, i) => (text.replace(/\s+/g, '').length < SCANNED_PAGE_CHARS ? i + 1 : 0))
      .filter((page) => page > 0)
      .slice(0, MAX_OCR_PAGES);
  }

  private async readPending(): Promise<void> {
    for (let doc = this.store.takePending(); doc; doc = this.store.takePending()) {
      try {
        if (isImageFile(doc.path)) {
          // A photo has no text layer: it goes straight to text recognition.
          if (this.ocr) this.store.saveChunks(doc.id, [], 'ocr');
          else this.store.markError(doc.id, 'Photos are read with text recognition, which is not available.');
          continue;
        }
        const isPdf = path.extname(doc.path).toLowerCase() === '.pdf';
        const extracted = await extractText(doc.path);
        const chunks = chunkText(extracted, isPdf);
        if (isPdf && this.ocr && this.scannedPages(extracted).length > 0) {
          // The pages with text are searchable now; the scanned ones follow.
          this.store.saveChunks(doc.id, chunks, 'ocr');
        } else if (chunks.length === 0) {
          this.store.markError(
            doc.id,
            isPdf ? 'No text found (a scanned PDF needs text recognition, which is not available).' : 'No text found.',
          );
        } else {
          this.store.saveChunks(doc.id, chunks);
        }
      } catch (error) {
        this.store.markError(doc.id, error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Embeddings for chunks that have none; without the model, keyword search still works. */
  private async embedMissing(): Promise<void> {
    for (
      let batch = this.store.chunksWithoutEmbedding(EMBED_BATCH);
      batch.length;
      batch = this.store.chunksWithoutEmbedding(EMBED_BATCH)
    ) {
      let vectors: Float32Array[];
      try {
        vectors = await this.embedder.embed(batch.map((chunk) => chunk.text));
      } catch (error) {
        log.warn('Embeddings postponed:', error instanceof Error ? error.message : String(error));
        return;
      }
      this.store.saveEmbeddings(batch.map((chunk, i) => ({ id: chunk.id, vector: vectors[i] })));
      // Documents added meanwhile are read before more embeddings.
      const counts = this.store.counts();
      if (this.again && counts.pending > counts.ocr) return;
    }
  }

  /** Reads a photo with text recognition. One without legible text is not an error. */
  private async recognizePhoto(doc: { id: number; path: string; name: string }): Promise<void> {
    this.ocrProgress = { name: doc.name, done: 0, total: 1 };
    try {
      const text = await this.ocr!.ocrImage(doc.path);
      const chunks = text ? chunkText({ pages: [text] }, false) : [];
      if (chunks.length === 0) {
        this.store.saveChunks(doc.id, []);
        this.store.setStatus(doc.id, 'no-text');
      } else {
        this.store.saveChunks(doc.id, chunks);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Text recognition failed for ${doc.name}:`, message);
      this.store.markError(doc.id, `Text recognition failed: ${message}`);
    } finally {
      this.ocrProgress = null;
    }
  }

  /** Reads a PDF's scanned pages with text recognition and indexes the whole document again. */
  private async recognize(doc: { id: number; path: string; name: string; chunkCount: number }): Promise<void> {
    if (isImageFile(doc.path)) {
      await this.recognizePhoto(doc);
      return;
    }
    try {
      const extracted = await extractText(doc.path);
      const pages = this.scannedPages(extracted);
      this.ocrProgress = { name: doc.name, done: 0, total: pages.length };
      const recognized = await this.ocr!.ocrPdf(doc.path, pages, (done, total) => {
        this.ocrProgress = { name: doc.name, done, total };
      });
      const merged = extracted.pages.map((text, i) => {
        const read = recognized[i + 1]?.trim();
        return read ? `${text.trim()}\n\n${read}`.trim() : text;
      });
      const chunks = chunkText({ pages: merged }, true);
      if (chunks.length === 0) {
        this.store.markError(
          doc.id,
          'No text found, also not with text recognition (handwriting and blurry or very small text cannot be read).',
        );
      } else {
        this.store.saveChunks(doc.id, chunks);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Text recognition failed for ${doc.name}:`, message);
      if (doc.chunkCount > 0) {
        // Keep the pages that had text.
        this.store.setStatus(doc.id, 'ready');
      } else {
        this.store.markError(doc.id, `Text recognition failed: ${message}`);
      }
    } finally {
      this.ocrProgress = null;
    }
  }

}

export type { SourceKind };
