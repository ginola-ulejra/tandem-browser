import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Embedder, EmbedderState } from '../embedder';
import { chunkText, CHUNK_CHARS, extractText } from '../extract';
import { DocumentLibrary } from '../library';
import { DocumentStore, toFtsQuery } from '../store';
import { combineToolboxes, createDocumentsToolbox, DOCUMENTS_TOOL, formatResults } from '../tool';
import type { BrowserToolbox } from '../../browserTools';

vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** A minimal one-page PDF with a text layer. */
function makePdf(text: string): Buffer {
  const stream = `BT /F1 11 Tf 40 760 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function makeDocx(text: string): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
  );
  zip.addFile(
    '_rels/.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
  );
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
  );
  return zip.toBuffer();
}

/** Bag-of-words vectors: enough to test ranking without the real model. */
class FakeEmbedder implements Embedder {
  readonly model = 'fake-model';
  calls = 0;
  fail = false;
  status(): EmbedderState {
    return this.fail ? { state: 'unavailable', error: 'no model' } : { state: 'ready' };
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    if (this.fail) throw new Error('no model');
    return texts.map((text) => {
      const vector = new Float32Array(64);
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        let hash = 0;
        for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) % 64;
        vector[hash] += 1;
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((x) => x / norm);
    });
  }
  dispose(): void {}
}

let dir: string;
let store: DocumentStore;
let embedder: FakeEmbedder;
let library: DocumentLibrary;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulejra-docs-'));
  fs.mkdirSync(path.join(dir, 'docs', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs', '.hidden'));
  store = new DocumentStore(path.join(dir, 'index.db'));
  embedder = new FakeEmbedder();
  library = new DocumentLibrary({ store, embedder, now: () => 1_800_000_000_000 });
});

afterEach(() => {
  library.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

const docPath = (...parts: string[]) => path.join(dir, 'docs', ...parts);

describe('reading documents', () => {
  it('reads text, Markdown, Word and PDF files, PDFs by page', async () => {
    fs.writeFileSync(docPath('a.txt'), 'Jam buka toko: Senin sampai Jumat.');
    fs.writeFileSync(docPath('b.docx'), makeDocx('Pelatihan dipandu oleh Ibu Rina.'));
    fs.writeFileSync(docPath('c.pdf'), makePdf('Invoice INV-118 total due Rp 12.500.000'));
    expect((await extractText(docPath('a.txt'))).pages).toEqual(['Jam buka toko: Senin sampai Jumat.']);
    expect((await extractText(docPath('b.docx'))).pages[0]).toContain('Ibu Rina');
    const pdf = await extractText(docPath('c.pdf'));
    expect(pdf.pages).toHaveLength(1);
    expect(pdf.pages[0]).toContain('INV-118');
  });

  it('refuses other file types', async () => {
    fs.writeFileSync(docPath('photo.jpg'), 'x');
    await expect(extractText(docPath('photo.jpg'))).rejects.toThrow(/not supported/);
  });

  it('cuts long text into overlapping chunks at sentence boundaries', () => {
    const sentence = 'Kalimat ini cukup panjang untuk mengisi potongan teks. ';
    const chunks = chunkText({ pages: [sentence.repeat(40)] }, false);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_CHARS);
      expect(chunk.text.endsWith('.')).toBe(true);
      expect(chunk.page).toBeNull();
    }
    const pdfChunks = chunkText({ pages: ['Halaman satu cukup panjang.', 'Halaman dua juga cukup panjang.'] }, true);
    expect(pdfChunks.map((chunk) => chunk.page)).toEqual([1, 2]);
  });

  it('turns a question into a safe keyword query', () => {
    expect(toFtsQuery('Kapan toko "buka"? OR NOT *')).toBe('"kapan"* OR "toko"* OR "buka"* OR "or"* OR "not"*');
    expect(toFtsQuery('?!')).toBeNull();
  });
});

describe('My Documents library', () => {
  beforeEach(() => {
    fs.writeFileSync(docPath('kebijakan.txt'), 'Jam operasional toko: Senin sampai Jumat pukul 08.00 hingga 17.00.');
    fs.writeFileSync(docPath('sub', 'gudang.md'), 'Sewa gudang di Cikarang Rp 45.000 per meter persegi per bulan.');
    fs.writeFileSync(docPath('sop.docx'), makeDocx('Karyawan baru wajib ikut pelatihan keselamatan kerja.'));
    fs.writeFileSync(docPath('.hidden', 'secret.txt'), 'rahasia');
    fs.writeFileSync(docPath('photo.jpg'), 'x');
  });

  it('indexes a folder, its subfolders and supported files only', async () => {
    const result = await library.add([docPath()]);
    await library.idle();
    expect(result).toEqual({ added: 1, skipped: [] });
    const status = library.status();
    expect(status.sources).toHaveLength(1);
    expect(status.sources[0]).toMatchObject({ kind: 'folder', name: 'docs', documents: 3, ready: 3, errors: 0 });
    expect(status.totals).toMatchObject({ documents: 3, ready: 3, embedded: 3 });
    expect(library.hasDocuments()).toBe(true);
  });

  it('finds the passage that answers a question', async () => {
    await library.add([docPath()]);
    await library.idle();
    const [best] = await library.search('berapa sewa gudang Cikarang');
    expect(best).toMatchObject({ name: 'gudang.md', page: null });
    expect(best.text).toContain('Rp 45.000');
    expect((await library.search('pelatihan karyawan'))[0].name).toBe('sop.docx');
    expect(await library.search('   ')).toEqual([]);
  });

  it('keeps keyword search working when the model cannot run', async () => {
    embedder.fail = true;
    await library.add([docPath()]);
    await library.idle();
    expect(library.status().totals).toMatchObject({ ready: 3, embedded: 0 });
    expect((await library.search('gudang'))[0].name).toBe('gudang.md');
  });

  it('picks up changed, new and deleted files on refresh', async () => {
    await library.add([docPath()]);
    await library.idle();
    fs.writeFileSync(docPath('kebijakan.txt'), 'Toko buka hari Sabtu khusus bulan Desember.');
    fs.writeFileSync(docPath('baru.txt'), 'Daftar harga baru berlaku mulai Januari.');
    fs.rmSync(docPath('sub', 'gudang.md'));
    await library.refresh();
    await library.idle();
    expect(library.status().totals).toMatchObject({ documents: 3, ready: 3 });
    expect((await library.search('buka Sabtu Desember'))[0].text).toContain('Desember');
    expect((await library.search('gudang Cikarang')).map((r) => r.name)).not.toContain('gudang.md');
  });

  it('reports a file it cannot read and keeps the rest', async () => {
    fs.writeFileSync(docPath('rusak.pdf'), 'not really a pdf');
    await library.add([docPath()]);
    await library.idle();
    const [source] = library.status().sources;
    expect(source).toMatchObject({ documents: 4, ready: 3, errors: 1 });
    expect(source.firstError).toMatch(/^rusak\.pdf: /);
  });

  it('adds single files, skips unsupported ones, and forgets what is removed', async () => {
    const result = await library.add([docPath('kebijakan.txt'), docPath('photo.jpg'), docPath('missing.txt')]);
    await library.idle();
    expect(result.added).toBe(1);
    expect(result.skipped).toEqual([docPath('photo.jpg'), docPath('missing.txt')]);
    const [source] = library.status().sources;
    expect(source).toMatchObject({ kind: 'file', name: 'kebijakan.txt', ready: 1 });
    expect(library.remove(source.id)).toBe(true);
    expect(library.status().totals).toMatchObject({ documents: 0, chunks: 0 });
    expect(await library.search('toko')).toEqual([]);
    expect(library.hasDocuments()).toBe(false);
  });

  it('drops embeddings made by another model', async () => {
    await library.add([docPath()]);
    await library.idle();
    store.useEmbeddingModel('another-model');
    expect(store.counts().embedded).toBe(0);
  });
});

describe('documents_search tool', () => {
  it('is offered only while there are documents, and returns passages with their file', async () => {
    const toolbox = createDocumentsToolbox(library);
    expect(toolbox.definitions).toEqual([]);
    fs.writeFileSync(docPath('kebijakan.txt'), 'Jam operasional toko: Senin sampai Jumat pukul 08.00 hingga 17.00.');
    await library.add([docPath()]);
    await library.idle();
    expect(toolbox.definitions.map((d) => d.function.name)).toEqual([DOCUMENTS_TOOL]);
    expect(toolbox.approvalFor(DOCUMENTS_TOOL, {})).toBeNull();
    const out = await toolbox.run(DOCUMENTS_TOOL, { query: 'jam buka toko' });
    expect(out).toMatch(/^\[1\] kebijakan\.txt\nJam operasional/);
    expect(formatResults([])).toBe('No matching passages in the user’s documents.');
    expect(JSON.parse(await toolbox.run(DOCUMENTS_TOOL, {}))).toMatchObject({ error: 'BAD_ARGUMENTS' });
  });

  it('combines with the browser tools: each call goes to the toolbox that has the tool', async () => {
    const browser: BrowserToolbox = {
      definitions: [{ type: 'function', function: { name: 'browser_click', description: '', parameters: {} } }],
      has: (name) => name === 'browser_click',
      approvalFor: () => 'Click the button',
      run: vi.fn(async () => 'clicked'),
    };
    const docs = createDocumentsToolbox(library);
    const combined = combineToolboxes(docs, browser);
    expect(combined.definitions.map((d) => d.function.name)).toEqual(['browser_click']);
    expect(combined.approvalFor('browser_click', {})).toBe('Click the button');
    expect(await combined.run('browser_click', {})).toBe('clicked');
    expect(combined.has(DOCUMENTS_TOOL)).toBe(true);
    expect(JSON.parse(await combined.run('nope', {}))).toMatchObject({ error: 'UNKNOWN_TOOL' });
  });
});
