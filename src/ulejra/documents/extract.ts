import fs from 'fs/promises';
import path from 'path';

/**
 * Text out of the user's documents, read on this computer. PDF (text layer only: scans and photos
 * have none), Word (.docx), and plain text formats.
 */

export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.docx',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
]);

/** Larger files are skipped: they are rarely documents someone asks questions about. */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
/** Text kept per document; the rest is not indexed. */
export const MAX_TEXT_CHARS = 2_000_000;

export class UnsupportedDocumentError extends Error {}

export interface ExtractedText {
  /** Pages for a PDF (index 0 = page 1); one entry for other formats. */
  pages: string[];
}

export function isSupportedFile(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** The part of unpdf (ESM-only, so its types do not resolve here) that is used. */
interface UnpdfModule {
  getDocumentProxy(data: Uint8Array): Promise<{ destroy?: () => Promise<void> }>;
  extractText(
    pdf: { destroy?: () => Promise<void> },
    options: { mergePages: false },
  ): Promise<{ totalPages: number; text: string[] | string }>;
}

/** unpdf is ESM-only; Node 22+ and Electron load it through require(esm) from this CommonJS build. */
const UNPDF = 'unpdf';

async function readPdf(data: Buffer): Promise<string[]> {
  const { extractText, getDocumentProxy } = (await import(UNPDF)) as UnpdfModule;
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    return Array.isArray(text) ? text : [text];
  } finally {
    // Frees pdf.js memory; not every unpdf build exposes it.
    await Promise.resolve(pdf.destroy?.()).catch(() => undefined);
  }
}

async function readDocx(data: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer: data });
  return value;
}

export async function extractText(filePath: string): Promise<ExtractedText> {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new UnsupportedDocumentError(`${ext || 'This file type'} is not supported.`);
  }
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new UnsupportedDocumentError(`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  }
  const data = await fs.readFile(filePath);
  let pages: string[];
  if (ext === '.pdf') {
    pages = await readPdf(data);
  } else if (ext === '.docx') {
    pages = [await readDocx(data)];
  } else {
    pages = [data.toString('utf8')];
  }
  let budget = MAX_TEXT_CHARS;
  pages = pages.map((page) => {
    const clean = page.split(String.fromCharCode(0)).join('').replace(/[ \t]+\n/g, '\n');
    const kept = clean.slice(0, Math.max(0, budget));
    budget -= kept.length;
    return kept;
  });
  return { pages };
}

export interface TextChunk {
  /** 1-based page for PDFs; null for other formats. */
  page: number | null;
  text: string;
}

/** About what the embedding model reads in one go (128 tokens). */
export const CHUNK_CHARS = 500;
export const CHUNK_OVERLAP = 80;

/**
 * Splits text into overlapping chunks of about CHUNK_CHARS characters, cutting at a paragraph,
 * sentence or word boundary where there is one.
 */
export function chunkText(extracted: ExtractedText, isPdf: boolean): TextChunk[] {
  const chunks: TextChunk[] = [];
  extracted.pages.forEach((raw, index) => {
    const text = raw.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    let start = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + CHUNK_CHARS);
      if (end < text.length) {
        const window = text.slice(start, end);
        const minCut = Math.floor(CHUNK_CHARS * 0.5);
        const cut = Math.max(
          window.lastIndexOf('\n\n'),
          window.lastIndexOf('. '),
          window.lastIndexOf('.\n'),
          window.lastIndexOf('? '),
          window.lastIndexOf('! '),
        );
        if (cut >= minCut) {
          end = start + cut + 1;
        } else {
          const space = window.lastIndexOf(' ');
          if (space >= minCut) end = start + space;
        }
      }
      const piece = text.slice(start, end).trim();
      if (piece.length >= 20 || (piece.length > 0 && chunks.length === 0 && end >= text.length)) {
        chunks.push({ page: isPdf ? index + 1 : null, text: piece });
      }
      if (end >= text.length) break;
      start = Math.max(end - CHUNK_OVERLAP, start + 1);
      // Start the overlap at a word boundary.
      const space = text.indexOf(' ', start);
      if (space !== -1 && space < end) start = space + 1;
    }
  });
  return chunks;
}
