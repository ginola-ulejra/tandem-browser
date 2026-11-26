import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type sharpModule from 'sharp';

/**
 * Text recognition (OCR) for scanned PDF pages and photos of documents, on this computer: the image
 * (taken out of the PDF with unpdf, or the photo itself) is cleaned up (sharp) and read by
 * Tesseract (tesseract.js, WebAssembly) in Indonesian and English. The language data (~7 MB) is
 * downloaded once into the cache folder.
 *
 * Runs inside the model process (embedder-process.ts), never in the app's main process.
 */

export const OCR_LANGUAGES = ['ind', 'eng'];
/** Images smaller than this share of the page's largest image are logos and decorations. */
const MIN_AREA_SHARE = 0.1;
/** Tesseract reads best at about 300 dpi; narrower page images are enlarged to this width. */
const TARGET_WIDTH = 2000;
const MAX_WIDTH = 3500;

interface PdfImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels?: number;
}

interface UnpdfModule {
  getDocumentProxy(data: Uint8Array): Promise<{ numPages: number; destroy?: () => Promise<void> }>;
  extractImages(pdf: unknown, page: number): Promise<PdfImage[]>;
}

interface TesseractWorker {
  recognize(image: Buffer): Promise<{ data: { text: string; confidence: number } }>;
  setParameters(params: Record<string, string>): Promise<unknown>;
  terminate(): Promise<unknown>;
}

const UNPDF = 'unpdf';
const TESSERACT = 'tesseract.js';
const SHARP = 'sharp';

let worker: Promise<TesseractWorker> | null = null;

function getWorker(cacheDir: string): Promise<TesseractWorker> {
  worker ??= (async () => {
    await fs.mkdir(cacheDir, { recursive: true });
    const { createWorker, OEM } = (await import(TESSERACT)) as {
      createWorker(langs: string[], oem: number, options: Record<string, unknown>): Promise<TesseractWorker>;
      OEM: { LSTM_ONLY: number };
    };
    const created = await createWorker(OCR_LANGUAGES, OEM.LSTM_ONLY, { cachePath: cacheDir });
    // Page images carry no resolution; without this Tesseract assumes a very low one.
    await created.setParameters({ user_defined_dpi: '300' });
    return created;
  })().catch((error) => {
    worker = null;
    throw error;
  });
  return worker;
}

export async function stopOcr(): Promise<void> {
  const current = worker;
  worker = null;
  if (current) await (await current.catch(() => null))?.terminate();
}

/** The page's scanned image(s) as PNGs ready for Tesseract, largest first. */
async function pageImages(pdf: unknown, unpdf: UnpdfModule, page: number): Promise<Buffer[]> {
  const sharp = ((await import(SHARP)) as { default: typeof sharpModule }).default;
  const images = (await unpdf.extractImages(pdf, page)).filter((image) => image.width >= 200 && image.height >= 200);
  if (images.length === 0) return [];
  const largest = Math.max(...images.map((image) => image.width * image.height));
  const out: Buffer[] = [];
  for (const image of images) {
    if (image.width * image.height < largest * MIN_AREA_SHARE) continue;
    const channels = (image.channels ?? image.data.length / (image.width * image.height)) as 1 | 2 | 3 | 4;
    if (![1, 2, 3, 4].includes(channels)) continue;
    let pipeline = sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
      raw: { width: image.width, height: image.height, channels },
    }).grayscale();
    if (image.width < TARGET_WIDTH) {
      pipeline = pipeline.resize({ width: Math.min(MAX_WIDTH, TARGET_WIDTH) });
    } else if (image.width > MAX_WIDTH) {
      pipeline = pipeline.resize({ width: MAX_WIDTH });
    }
    out.push(await pipeline.normalize().png().toBuffer());
  }
  return out;
}

/**
 * Recognized text of the given 1-based pages of a PDF. Pages without a scanned image come back as
 * ''. `onPage` is called after each page.
 */
export async function ocrPdfPages(
  filePath: string,
  pages: number[],
  cacheDir: string,
  onPage?: (done: number, total: number) => void,
): Promise<Record<number, string>> {
  const unpdf = (await import(UNPDF)) as UnpdfModule;
  const pdf = await unpdf.getDocumentProxy(new Uint8Array(await fs.readFile(filePath)));
  const result: Record<number, string> = {};
  try {
    const ocr = await getWorker(cacheDir);
    let done = 0;
    for (const page of pages) {
      const texts: string[] = [];
      if (page >= 1 && page <= pdf.numPages) {
        for (const image of await pageImages(pdf, unpdf, page)) {
          const { data } = await ocr.recognize(image);
          // Very low confidence is noise (photos, patterns), not text.
          if (data.confidence >= 30 && data.text.trim()) texts.push(data.text.trim());
        }
      }
      result[page] = texts.join('\n\n');
      onPage?.(++done, pages.length);
    }
  } finally {
    await Promise.resolve(pdf.destroy?.()).catch(() => undefined);
  }
  return result;
}

/** Less legible text than this in a photo means it is not a photo of a document. */
const MIN_PHOTO_CHARS = 20;

/**
 * An iPhone HEIC photo as JPEG. sharp's prebuilt libvips cannot decode HEVC, but macOS can (sips).
 */
async function heicToJpeg(filePath: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
  if (process.platform !== 'darwin') {
    throw new Error('HEIC photos can only be read on macOS; save the photo as JPEG instead.');
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ulejra-heic-'));
  const file = path.join(dir, 'photo.jpg');
  await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'jpeg', filePath, '--out', file], { timeout: 60_000 });
  return { file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Recognized text of a photo of a document; '' when it holds no legible text. */
export async function ocrImageFile(filePath: string, cacheDir: string): Promise<string> {
  const sharp = ((await import(SHARP)) as { default: typeof sharpModule }).default;
  const isHeic = /\.hei[cf]$/i.test(filePath);
  const source = isHeic ? await heicToJpeg(filePath) : { file: filePath, cleanup: async () => undefined };
  try {
    // rotate() turns the photo upright from its EXIF orientation (phones store it sideways).
    let pipeline = sharp(source.file, { failOn: 'none' }).rotate().grayscale();
    const { width = 0 } = await sharp(source.file, { failOn: 'none' }).rotate().metadata();
    if (width > MAX_WIDTH) pipeline = pipeline.resize({ width: MAX_WIDTH });
    else if (width > 0 && width < TARGET_WIDTH) pipeline = pipeline.resize({ width: TARGET_WIDTH });
    const image = await pipeline.normalize().png().toBuffer();
    const { data } = await (await getWorker(cacheDir)).recognize(image);
    const text = data.text.trim();
    return data.confidence >= 30 && text.replace(/\s+/g, '').length >= MIN_PHOTO_CHARS ? text : '';
  } finally {
    await source.cleanup();
  }
}
