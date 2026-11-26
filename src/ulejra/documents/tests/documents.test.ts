import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Embedder, EmbedderState, PdfOcr } from '../embedder';
import { chunkText, CHUNK_CHARS, extractText } from '../extract';
import { DocumentLibrary, WATCH_DEBOUNCE_MS, type WatchFn } from '../library';
import { DocumentStore, toFtsQuery } from '../store';
import { citedSources, combineToolboxes, createDocumentsToolbox, definitionWithHint, DOCUMENTS_TOOL, formatResults } from '../tool';
import { recognizeUpright, type TesseractWorker } from '../ocr';
import type { BrowserToolbox } from '../../browserTools';

vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** A minimal PDF, one page per entry; an empty string is a page without text (like a scan). */
function makePdf(...pages: string[]): Buffer {
  const count = pages.length;
  const font = 3 + count * 2;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${count} >>`,
    ...pages.map(
      (_, i) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${3 + count + i} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    ),
    ...pages.map((text) => {
      const stream = text ? `BT /F1 11 Tf 40 760 Td (${text}) Tj ET` : 'BT ET';
      return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }),
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

/** Stands in for Tesseract: returns the text set for a page, or fails. */
class FakeOcr implements PdfOcr {
  pagesText: Record<number, string> = {};
  /** Text per photo file name. */
  photos: Record<string, string> = {};
  fail = false;
  calls: Array<{ file: string; pages: number[] }> = [];
  photoCalls: string[] = [];
  async ocrImage(file: string) {
    this.photoCalls.push(path.basename(file));
    if (this.fail) throw new Error('language data could not be downloaded');
    return this.photos[path.basename(file)] ?? '';
  }
  async ocrPdf(file: string, pages: number[], onPage?: (done: number, total: number) => void) {
    this.calls.push({ file: path.basename(file), pages });
    if (this.fail) throw new Error('language data could not be downloaded');
    const out: Record<number, string> = {};
    pages.forEach((page, i) => {
      out[page] = this.pagesText[page] ?? '';
      onPage?.(i + 1, pages.length);
    });
    return out;
  }
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
  library = new DocumentLibrary({ store, embedder, now: () => 1_800_000_000_000, watch: null });
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

  it('refuses other file types (photos go to text recognition instead)', async () => {
    fs.writeFileSync(docPath('arsip.zip'), 'x');
    fs.writeFileSync(docPath('photo.jpg'), 'x');
    await expect(extractText(docPath('arsip.zip'))).rejects.toThrow(/not supported/);
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
    expect(toFtsQuery('berapa kembalian')).toBe('"berapa"* OR "kembalian"* OR "kembali"*');
    expect(toFtsQuery('tagihannya refunds')).toBe('"tagihannya"* OR "tagihan"* OR "refunds"* OR "refund"*');
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
    fs.writeFileSync(docPath('arsip.zip'), 'x');
    const result = await library.add([docPath('kebijakan.txt'), docPath('arsip.zip'), docPath('missing.txt')]);
    await library.idle();
    expect(result.added).toBe(1);
    expect(result.skipped).toEqual([docPath('arsip.zip'), docPath('missing.txt')]);
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

describe('scanned PDFs (text recognition)', () => {
  let ocr: FakeOcr;
  let withOcr: DocumentLibrary;
  let ocrStore: DocumentStore;

  beforeEach(() => {
    ocr = new FakeOcr();
    ocrStore = new DocumentStore(path.join(dir, 'ocr.db'));
    withOcr = new DocumentLibrary({ store: ocrStore, embedder, ocr, watch: null });
  });

  afterEach(() => withOcr.dispose());

  it('reads a scanned PDF with text recognition and finds its text by page', async () => {
    fs.writeFileSync(docPath('kontrak-scan.pdf'), makePdf('', ''));
    ocr.pagesText = { 1: 'Surat perjanjian sewa gudang di Cikarang.', 2: 'Uang jaminan sebesar dua bulan sewa dibayar di muka.' };
    await withOcr.add([docPath()]);
    await withOcr.idle();
    expect(ocr.calls).toEqual([{ file: 'kontrak-scan.pdf', pages: [1, 2] }]);
    expect(withOcr.status().totals).toMatchObject({ documents: 1, ready: 1, ocr: 0, chunks: 2 });
    expect(withOcr.status().ocr).toBeNull();
    const [hit] = await withOcr.search('uang jaminan');
    expect(hit).toMatchObject({ name: 'kontrak-scan.pdf', page: 2 });
  });

  it('only recognizes the scanned pages of a PDF that also has text pages', async () => {
    fs.writeFileSync(docPath('campuran.pdf'), makePdf('Laporan keuangan Warung Sari tahun 2026, ringkasan untuk pemilik.', ''));
    ocr.pagesText = { 2: 'Salinan kontrak sewa gudang.' };
    await withOcr.add([docPath()]);
    await withOcr.idle();
    expect(ocr.calls[0].pages).toEqual([2]);
    expect((await withOcr.search('laporan keuangan'))[0]).toMatchObject({ name: 'campuran.pdf', page: 1 });
    expect((await withOcr.search('kontrak sewa gudang'))[0]).toMatchObject({ name: 'campuran.pdf', page: 2 });
  });

  it('says so when even text recognition finds nothing', async () => {
    fs.writeFileSync(docPath('foto.pdf'), makePdf(''));
    await withOcr.add([docPath()]);
    await withOcr.idle();
    expect(withOcr.status().sources[0].firstError).toMatch(/^foto\.pdf: No text found, also not with text recognition/);
  });

  it('keeps the text pages when text recognition fails, and reports a scan that has none', async () => {
    ocr.fail = true;
    fs.writeFileSync(docPath('campuran.pdf'), makePdf('Laporan keuangan Warung Sari tahun 2026, ringkasan untuk pemilik.', ''));
    fs.writeFileSync(docPath('scan.pdf'), makePdf(''));
    await withOcr.add([docPath()]);
    await withOcr.idle();
    const [source] = withOcr.status().sources;
    expect(source).toMatchObject({ documents: 2, ready: 1, errors: 1 });
    expect(source.firstError).toBe('scan.pdf: Text recognition failed: language data could not be downloaded');
    expect((await withOcr.search('laporan keuangan'))[0].name).toBe('campuran.pdf');
  });

  it('picks up a scan left half-read when the app quit', async () => {
    fs.writeFileSync(docPath('scan.pdf'), makePdf(''));
    ocr.pagesText = { 1: 'Nomor faktur INV-118 jatuh tempo 30 Desember.' };
    await withOcr.add([docPath()]);
    await withOcr.idle();
    ocrStore.setStatus(1, 'ocr-running');
    const reopened = new DocumentLibrary({ store: ocrStore, embedder, ocr, watch: null });
    reopened.start();
    await reopened.idle();
    expect(ocr.calls).toHaveLength(2);
    expect(reopened.status().totals).toMatchObject({ ready: 1, ocr: 0 });
  });

  it('without text recognition, a scanned PDF is reported as unreadable', async () => {
    fs.writeFileSync(docPath('scan.pdf'), makePdf(''));
    await library.add([docPath()]);
    await library.idle();
    expect(library.status().sources[0].firstError).toBe(
      'scan.pdf: No text found (a scanned PDF needs text recognition, which is not available).',
    );
  });
});

describe('photos of documents (text recognition)', () => {
  let ocr: FakeOcr;
  let withOcr: DocumentLibrary;

  beforeEach(() => {
    ocr = new FakeOcr();
    withOcr = new DocumentLibrary({ store: new DocumentStore(path.join(dir, 'photos.db')), embedder, ocr, watch: null });
    fs.mkdirSync(docPath('foto'), { recursive: true });
    fs.writeFileSync(docPath('foto', 'struk.jpg'), 'jpeg bytes');
    fs.writeFileSync(docPath('foto', 'liburan.png'), 'png bytes');
    fs.writeFileSync(docPath('foto', 'catatan.txt'), 'Catatan rapat: anggaran pemasaran naik sepuluh persen.');
    ocr.photos = { 'struk.jpg': 'Struk belanja Toko Sinar total Rp 87.500 tanggal 20 November.' };
  });

  afterEach(() => withOcr.dispose());

  it('reads a photo added on its own', async () => {
    await withOcr.add([docPath('foto', 'struk.jpg')]);
    await withOcr.idle();
    expect(ocr.photoCalls).toEqual(['struk.jpg']);
    expect(withOcr.status().sources[0]).toMatchObject({ kind: 'file', ready: 1 });
    expect((await withOcr.search('total struk belanja'))[0]).toMatchObject({ name: 'struk.jpg', page: null });
  });

  it('leaves a folder’s photos out until the user turns them on, and drops them when turned off', async () => {
    await withOcr.add([docPath('foto')]);
    await withOcr.idle();
    let [source] = withOcr.status().sources;
    expect(source).toMatchObject({ includeImages: false, documents: 1, ready: 1 });
    expect(ocr.photoCalls).toEqual([]);

    expect(await withOcr.setIncludeImages(source.id, true)).toBe(true);
    await withOcr.idle();
    [source] = withOcr.status().sources;
    expect(source).toMatchObject({ includeImages: true, documents: 3, ready: 2, noText: 1, errors: 0 });
    expect(ocr.photoCalls.sort()).toEqual(['liburan.png', 'struk.jpg']);
    expect((await withOcr.search('struk belanja'))[0].name).toBe('struk.jpg');

    await withOcr.setIncludeImages(source.id, false);
    await withOcr.idle();
    expect(withOcr.status().sources[0]).toMatchObject({ includeImages: false, documents: 1, noText: 0 });
    expect((await withOcr.search('struk belanja')).map((r) => r.name)).not.toContain('struk.jpg');
  });

  it('only folders have the photo option', async () => {
    await withOcr.add([docPath('foto', 'catatan.txt')]);
    const [source] = withOcr.status().sources;
    expect(await withOcr.setIncludeImages(source.id, true)).toBe(false);
    expect(await withOcr.setIncludeImages(999, true)).toBe(false);
  });

  it('reports a photo it could not read', async () => {
    ocr.fail = true;
    await withOcr.add([docPath('foto', 'struk.jpg')]);
    await withOcr.idle();
    expect(withOcr.status().sources[0].firstError).toBe(
      'struk.jpg: Text recognition failed: language data could not be downloaded',
    );
  });

  it('without text recognition, a photo is reported as unreadable', async () => {
    await library.add([docPath('foto', 'struk.jpg')]);
    await library.idle();
    expect(library.status().sources[0].firstError).toBe(
      'struk.jpg: Photos are read with text recognition, which is not available.',
    );
  });

  it('keeps the photo option of an index made before photos were supported', () => {
    const legacy = path.join(dir, 'legacy.db');
    const old = new (require('better-sqlite3'))(legacy);
    old.exec(`CREATE TABLE sources (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, added_at INTEGER NOT NULL);
              INSERT INTO sources (path, kind, added_at) VALUES ('/old/folder', 'folder', 1);`);
    old.close();
    const migrated = new DocumentStore(legacy);
    expect(migrated.listSources()).toEqual([{ id: 1, path: '/old/folder', kind: 'folder', addedAt: 1, includeImages: false }]);
    migrated.close();
  });
});

describe('watching added folders and files', () => {
  it('indexes new, changed and deleted files in a watched folder by itself', async () => {
    const watched = new DocumentLibrary({ store: new DocumentStore(path.join(dir, 'watch.db')), embedder });
    try {
      fs.writeFileSync(docPath('harga.txt'), 'Harga kopi susu Rp 18.000 per gelas.');
      await watched.add([docPath()]);
      await watched.idle();
      fs.writeFileSync(docPath('sub', 'baru.txt'), 'Jadwal rapat pemegang saham hari Kamis.');
      fs.writeFileSync(docPath('harga.txt'), 'Harga kopi susu naik menjadi Rp 20.000 per gelas.');
      await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS + 1_500));
      await watched.idle();
      expect(watched.status().totals).toMatchObject({ documents: 2, ready: 2 });
      expect((await watched.search('rapat pemegang saham'))[0].name).toBe('baru.txt');
      expect((await watched.search('harga kopi susu'))[0].text).toContain('Rp 20.000');
      fs.rmSync(docPath('sub', 'baru.txt'));
      await new Promise((resolve) => setTimeout(resolve, WATCH_DEBOUNCE_MS + 1_500));
      await watched.idle();
      expect(watched.status().totals).toMatchObject({ documents: 1 });
    } finally {
      watched.dispose();
    }
  }, 15_000);

  it('watches a file through its folder, ignores its neighbours, and stops watching what is removed', async () => {
    const watchers: Array<{ target: string; recursive: boolean; listener: (e: string, f: string | null) => void; closed: boolean }> = [];
    const watch: WatchFn = (target, options, listener) => {
      const entry = { target, recursive: options.recursive, listener, closed: false };
      watchers.push(entry);
      return { close: () => { entry.closed = true; } };
    };
    const watched = new DocumentLibrary({ store: new DocumentStore(path.join(dir, 'watch2.db')), embedder, watch });
    fs.writeFileSync(docPath('harga.txt'), 'Harga kopi susu Rp 18.000 per gelas.');
    await watched.add([docPath('harga.txt'), docPath('sub')]);
    await watched.idle();
    expect(watchers.map(({ target, recursive }) => ({ target, recursive }))).toEqual([
      { target: docPath(), recursive: false },
      { target: docPath('sub'), recursive: true },
    ]);
    const sources = watched.status().sources;
    watched.remove(sources[0].id);
    expect(watchers[0].closed).toBe(true);
    watched.dispose();
    expect(watchers[1].closed).toBe(true);
  });
});

describe('reading pages the right way up', () => {
  /** Answers with the confidences given, in call order. */
  function fakeWorker(confidences: number[]) {
    const calls: Array<{ width: number; height: number }> = [];
    return {
      calls,
      worker: {
        async recognize(image: Buffer) {
          const { default: sharp } = await import('sharp');
          const { width = 0, height = 0 } = await sharp(image).metadata();
          calls.push({ width, height });
          const confidence = confidences[calls.length - 1] ?? 0;
          return { data: { text: `read #${calls.length}`, confidence } };
        },
        setParameters: async () => undefined,
        terminate: async () => undefined,
      } satisfies TesseractWorker,
    };
  }

  async function page(width: number, height: number): Promise<Buffer> {
    const { default: sharp } = await import('sharp');
    return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer();
  }

  it('keeps a page that already reads well', async () => {
    const { worker, calls } = fakeWorker([92]);
    expect(await recognizeUpright(worker, await page(1200, 1600))).toEqual({ text: 'read #1', confidence: 92, rotation: 0 });
    expect(calls).toHaveLength(1);
  });

  it('turns a page that reads best another way round, using small previews to decide', async () => {
    // Full read (poor), previews at 0/90/180/270, then the full read at 180°.
    const { worker, calls } = fakeWorker([41, 38, 22, 87, 30, 90]);
    expect(await recognizeUpright(worker, await page(1200, 1600))).toEqual({ text: 'read #6', confidence: 90, rotation: 180 });
    expect(calls.slice(1, 5)).toEqual([
      { width: 1000, height: 1333 },
      { width: 1333, height: 1000 },
      { width: 1000, height: 1333 },
      { width: 1333, height: 1000 },
    ]);
    expect(calls[5]).toEqual({ width: 1200, height: 1600 });
  });

  it('keeps the first reading when no other orientation is better', async () => {
    const { worker, calls } = fakeWorker([45, 50, 20, 21, 19]);
    expect(await recognizeUpright(worker, await page(800, 600))).toEqual({ text: 'read #1', confidence: 45, rotation: 0 });
    expect(calls).toHaveLength(5);
  });
});

describe('sources under an answer', () => {
  const kontrak = { documentId: 1, name: 'Kontrak Sewa.pdf', page: 2 };
  const menu = { documentId: 2, name: 'menu.txt', page: null };

  it('keeps the documents the answer names, with or without the extension, once per page', () => {
    const found = [kontrak, menu, { ...kontrak }, { ...kontrak, page: 3 }];
    expect(citedSources('Menurut Kontrak Sewa, jaminannya dua bulan.', found)).toEqual([kontrak, { ...kontrak, page: 3 }]);
    expect(citedSources('Lihat menu.txt untuk harga.', found)).toEqual([menu]);
    expect(citedSources('Saya tidak menemukan jawabannya.', found)).toEqual([]);
  });

  it('the documents toolbox remembers what each search returned until it is asked', async () => {
    fs.writeFileSync(docPath('kebijakan.txt'), 'Jam operasional toko: Senin sampai Jumat pukul 08.00 hingga 17.00.');
    await library.add([docPath()]);
    await library.idle();
    const toolbox = combineToolboxes(createDocumentsToolbox(library));
    await toolbox.run(DOCUMENTS_TOOL, { query: 'jam buka toko' });
    const [source] = toolbox.takeSources!();
    expect(source).toMatchObject({ name: 'kebijakan.txt', page: null });
    expect(library.documentPath(source.documentId)).toBe(docPath('kebijakan.txt'));
    expect(toolbox.takeSources!()).toEqual([]);
    expect(library.documentPath(999)).toBeNull();
  });
});

describe('hinting the assistant at likely documents', () => {
  it('names only strongly matching documents for the latest message, and nothing otherwise', async () => {
    fs.writeFileSync(docPath('gudang.txt'), 'Sewa gudang Cikarang dengan uang jaminan dua bulan sewa.');
    fs.writeFileSync(docPath('menu.txt'), 'Daftar menu nasi goreng dan mie ayam.');
    await library.add([docPath()]);
    await library.idle();
    expect(await library.likelyDocuments('uang jaminan sewa gudang Cikarang')).toEqual(['gudang.txt']);
    expect(await library.likelyDocuments('ibu kota jepang')).toEqual([]);
    expect(await library.likelyDocuments('   ')).toEqual([]);

    const toolbox = combineToolboxes(createDocumentsToolbox(library));
    await toolbox.prepare!('uang jaminan sewa gudang Cikarang');
    expect(toolbox.definitions[0].function.description).toContain('these of their documents look relevant: gudang.txt.');
    await toolbox.prepare!('ibu kota jepang');
    expect(toolbox.definitions[0].function.description).not.toContain('look relevant');
  });

  it('gives no hint while the model cannot run', async () => {
    fs.writeFileSync(docPath('gudang.txt'), 'Sewa gudang Cikarang dengan uang jaminan dua bulan sewa.');
    await library.add([docPath()]);
    await library.idle();
    embedder.fail = true;
    expect(await library.likelyDocuments('uang jaminan sewa gudang')).toEqual([]);
  });

  it('leaves the tool as it is without likely documents', () => {
    expect(definitionWithHint([]).function.description).not.toContain('look relevant');
    expect(definitionWithHint(['a.pdf', 'b.jpg']).function.description).toMatch(/look relevant: a\.pdf, b\.jpg\. Search them/);
  });
});
