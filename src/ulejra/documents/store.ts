import Database from 'better-sqlite3';
import type { TextChunk } from './extract';

/**
 * The user's documents index, on this computer only: what was added (files and folders), the text
 * of each document cut into chunks, a keyword index (SQLite FTS5) and each chunk's embedding.
 */

export type SourceKind = 'file' | 'folder';
export type DocumentStatus = 'pending' | 'indexing' | 'ready' | 'error';

export interface SourceRow {
  id: number;
  path: string;
  kind: SourceKind;
  addedAt: number;
}

export interface DocumentRow {
  id: number;
  sourceId: number;
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  status: DocumentStatus;
  error: string | null;
  chunkCount: number;
}

export interface ChunkHit {
  chunkId: number;
  documentId: number;
  name: string;
  path: string;
  page: number | null;
  ord: number;
  text: string;
}

export interface SourceSummary extends SourceRow {
  documents: number;
  ready: number;
  pending: number;
  errors: number;
  chunks: number;
  embedded: number;
  /** The first error message, for a file source or the first failing file of a folder. */
  firstError: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS documents_source ON documents(source_id);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  page INTEGER,
  text TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id, ord);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;

/** Words of a free-text query as an FTS5 expression: any word may match, best matches first. */
export function toFtsQuery(query: string): string | null {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const unique = [...new Set(words)].slice(0, 24);
  if (unique.length === 0) return null;
  return unique.map((word) => `"${word}"*`).join(' OR ');
}

function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function fromBlob(blob: Buffer): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

export class DocumentStore {
  private readonly db: Database.Database;
  /** Every embedded chunk's vector, loaded on the first vector search; dropped on any change. */
  private vectors: { ids: number[]; data: Float32Array[] } | null = null;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** The embedding model the stored vectors came from; switching models drops them. */
  useEmbeddingModel(model: string): void {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'embedding_model'`).get() as
      | { value: string }
      | undefined;
    if (row?.value === model) return;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE chunks SET embedding = NULL`).run();
      this.db
        .prepare(`INSERT INTO meta (key, value) VALUES ('embedding_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(model);
    })();
    this.vectors = null;
  }

  addSource(sourcePath: string, kind: SourceKind, now: number): SourceRow {
    this.db
      .prepare(`INSERT INTO sources (path, kind, added_at) VALUES (?, ?, ?) ON CONFLICT(path) DO NOTHING`)
      .run(sourcePath, kind, now);
    return this.toSource(this.db.prepare(`SELECT * FROM sources WHERE path = ?`).get(sourcePath));
  }

  getSource(id: number): SourceRow | null {
    const row = this.db.prepare(`SELECT * FROM sources WHERE id = ?`).get(id);
    return row ? this.toSource(row) : null;
  }

  listSources(): SourceRow[] {
    return this.db.prepare(`SELECT * FROM sources ORDER BY added_at, id`).all().map((row) => this.toSource(row));
  }

  removeSource(id: number): boolean {
    const removed = this.db.transaction(() => {
      // Chunks go first so the FTS delete trigger sees each row.
      this.db.prepare(`DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE source_id = ?)`).run(id);
      return this.db.prepare(`DELETE FROM sources WHERE id = ?`).run(id).changes > 0;
    })();
    this.vectors = null;
    return removed;
  }

  summaries(): SourceSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
           COUNT(d.id) AS documents,
           SUM(d.status = 'ready') AS ready,
           SUM(d.status IN ('pending', 'indexing')) AS pending,
           SUM(d.status = 'error') AS errors,
           COALESCE(SUM(d.chunk_count), 0) AS chunks,
           (SELECT COUNT(*) FROM chunks c JOIN documents d2 ON d2.id = c.document_id
              WHERE d2.source_id = s.id AND c.embedding IS NOT NULL) AS embedded,
           (SELECT d3.name || ': ' || d3.error FROM documents d3
              WHERE d3.source_id = s.id AND d3.status = 'error' ORDER BY d3.id LIMIT 1) AS first_error
         FROM sources s LEFT JOIN documents d ON d.source_id = s.id
         GROUP BY s.id ORDER BY s.added_at, s.id`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...this.toSource(row),
      documents: Number(row.documents ?? 0),
      ready: Number(row.ready ?? 0),
      pending: Number(row.pending ?? 0),
      errors: Number(row.errors ?? 0),
      chunks: Number(row.chunks ?? 0),
      embedded: Number(row.embedded ?? 0),
      firstError: (row.first_error as string | null) ?? null,
    }));
  }

  /** Records a file; a new file, or one whose size or time changed, goes back to pending. */
  upsertDocument(input: { sourceId: number; path: string; name: string; size: number; mtimeMs: number }): void {
    const existing = this.db.prepare(`SELECT id, size, mtime_ms FROM documents WHERE path = ?`).get(input.path) as
      | { id: number; size: number; mtime_ms: number }
      | undefined;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO documents (source_id, path, name, size, mtime_ms, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
        )
        .run(input.sourceId, input.path, input.name, input.size, Math.trunc(input.mtimeMs));
      return;
    }
    if (existing.size !== input.size || existing.mtime_ms !== Math.trunc(input.mtimeMs)) {
      this.db
        .prepare(`UPDATE documents SET size = ?, mtime_ms = ?, status = 'pending', error = NULL WHERE id = ?`)
        .run(input.size, Math.trunc(input.mtimeMs), existing.id);
    }
  }

  /** Removes the source's documents that are no longer among `paths`. */
  pruneDocuments(sourceId: number, paths: Set<string>): number {
    const rows = this.db.prepare(`SELECT id, path FROM documents WHERE source_id = ?`).all(sourceId) as Array<{
      id: number;
      path: string;
    }>;
    const gone = rows.filter((row) => !paths.has(row.path));
    this.db.transaction(() => {
      for (const row of gone) {
        this.db.prepare(`DELETE FROM chunks WHERE document_id = ?`).run(row.id);
        this.db.prepare(`DELETE FROM documents WHERE id = ?`).run(row.id);
      }
    })();
    if (gone.length) this.vectors = null;
    return gone.length;
  }

  /** The next document waiting to be read, marked as being indexed. */
  takePending(): DocumentRow | null {
    const row = this.db.prepare(`SELECT * FROM documents WHERE status = 'pending' ORDER BY id LIMIT 1`).get();
    if (!row) return null;
    const doc = this.toDocument(row);
    this.db.prepare(`UPDATE documents SET status = 'indexing' WHERE id = ?`).run(doc.id);
    return { ...doc, status: 'indexing' };
  }

  /** Documents left half-indexed by a previous run go back to pending. */
  resetInterrupted(): void {
    this.db.prepare(`UPDATE documents SET status = 'pending' WHERE status = 'indexing'`).run();
  }

  saveChunks(documentId: number, chunks: TextChunk[]): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM chunks WHERE document_id = ?`).run(documentId);
      const insert = this.db.prepare(`INSERT INTO chunks (document_id, ord, page, text) VALUES (?, ?, ?, ?)`);
      chunks.forEach((chunk, ord) => insert.run(documentId, ord, chunk.page, chunk.text));
      this.db
        .prepare(`UPDATE documents SET status = 'ready', error = NULL, chunk_count = ? WHERE id = ?`)
        .run(chunks.length, documentId);
    })();
    this.vectors = null;
  }

  markError(documentId: number, message: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM chunks WHERE document_id = ?`).run(documentId);
      this.db
        .prepare(`UPDATE documents SET status = 'error', error = ?, chunk_count = 0 WHERE id = ?`)
        .run(message.slice(0, 300), documentId);
    })();
    this.vectors = null;
  }

  chunksWithoutEmbedding(limit: number): Array<{ id: number; text: string }> {
    return this.db
      .prepare(`SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT ?`)
      .all(limit) as Array<{ id: number; text: string }>;
  }

  saveEmbeddings(items: Array<{ id: number; vector: Float32Array }>): void {
    const update = this.db.prepare(`UPDATE chunks SET embedding = ? WHERE id = ?`);
    this.db.transaction(() => {
      for (const item of items) update.run(toBlob(item.vector), item.id);
    })();
    this.vectors = null;
  }

  counts(): { documents: number; ready: number; pending: number; chunks: number; embedded: number } {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM documents) AS documents,
           (SELECT COUNT(*) FROM documents WHERE status = 'ready') AS ready,
           (SELECT COUNT(*) FROM documents WHERE status IN ('pending', 'indexing')) AS pending,
           (SELECT COUNT(*) FROM chunks) AS chunks,
           (SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL) AS embedded`,
      )
      .get() as Record<string, number>;
    return {
      documents: row.documents,
      ready: row.ready,
      pending: row.pending,
      chunks: row.chunks,
      embedded: row.embedded,
    };
  }

  /** Chunk ids by keyword relevance (BM25), best first. */
  keywordSearch(query: string, limit: number): number[] {
    const expression = toFtsQuery(query);
    if (!expression) return [];
    try {
      return (
        this.db
          .prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`)
          .all(expression, limit) as Array<{ rowid: number }>
      ).map((row) => row.rowid);
    } catch {
      return [];
    }
  }

  /** Chunk ids by cosine similarity to `query` (vectors are normalized), best first. */
  vectorSearch(query: Float32Array, limit: number, minScore = 0.3): number[] {
    if (!this.vectors) {
      const rows = this.db.prepare(`SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL`).all() as Array<{
        id: number;
        embedding: Buffer;
      }>;
      this.vectors = { ids: rows.map((row) => row.id), data: rows.map((row) => fromBlob(row.embedding)) };
    }
    const scored: Array<{ id: number; score: number }> = [];
    const { ids, data } = this.vectors;
    for (let i = 0; i < ids.length; i++) {
      const vector = data[i];
      if (vector.length !== query.length) continue;
      let dot = 0;
      for (let j = 0; j < vector.length; j++) dot += vector[j] * query[j];
      if (dot >= minScore) scored.push({ id: ids[i], score: dot });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((entry) => entry.id);
  }

  /** The chunks by id, in the order given, with their document. */
  getChunks(ids: number[]): ChunkHit[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT c.id, c.document_id, c.ord, c.page, c.text, d.name, d.path
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE c.id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is Record<string, unknown> => Boolean(row))
      .map((row) => ({
        chunkId: Number(row.id),
        documentId: Number(row.document_id),
        name: String(row.name),
        path: String(row.path),
        page: row.page == null ? null : Number(row.page),
        ord: Number(row.ord),
        text: String(row.text),
      }));
  }

  /** The chunk right after `ord` in the same document, for context. */
  nextChunkText(documentId: number, ord: number): string | null {
    const row = this.db.prepare(`SELECT text FROM chunks WHERE document_id = ? AND ord = ?`).get(documentId, ord + 1) as
      | { text: string }
      | undefined;
    return row?.text ?? null;
  }

  private toSource(row: unknown): SourceRow {
    const r = row as Record<string, unknown>;
    return { id: Number(r.id), path: String(r.path), kind: r.kind as SourceKind, addedAt: Number(r.added_at) };
  }

  private toDocument(row: unknown): DocumentRow {
    const r = row as Record<string, unknown>;
    return {
      id: Number(r.id),
      sourceId: Number(r.source_id),
      path: String(r.path),
      name: String(r.name),
      size: Number(r.size),
      mtimeMs: Number(r.mtime_ms),
      status: r.status as DocumentStatus,
      error: (r.error as string | null) ?? null,
      chunkCount: Number(r.chunk_count),
    };
  }
}
