/**
 * AG Lex — file → Markdown microservice.
 *
 * Why a separate Node.js service:
 *   - Mammoth (JS) preserves DOCX list nesting and table structure far
 *     better than the python-mammoth port.
 *   - tesseract.js with the `ukr+eng` traineddata is the easiest way to
 *     OCR scanned Ukrainian contracts without forcing system Tesseract.
 *   - Keeping the heavy native deps out of the FastAPI image keeps the
 *     backend cold-start cheap.
 *
 * Contract:
 *   POST /convert  (multipart/form-data, field "file")
 *     →  200  { markdown, meta: { title, pages?, word_count, format } }
 *     →  413  if the upload exceeds MAX_BYTES
 *     →  415  for an unsupported extension
 *     →  500  if conversion blows up unrecoverably
 *
 * Files are processed in-memory; nothing is written to disk except for
 * the libraries (pdf-parse, word-extractor) that demand a Buffer.
 */
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import pdfParse from 'pdf-parse';
import PDFParser from 'pdf2json';
import WordExtractor from 'word-extractor';
import * as XLSX from 'xlsx';
import { parse as csvParse } from 'csv-parse/sync';
import { createWorker } from 'tesseract.js';

const PORT = Number(process.env.PORT || 3031);
const MAX_BYTES = Number(process.env.MAX_BYTES || 25 * 1024 * 1024); // 25 MB
const OCR_TEXT_THRESHOLD = Number(process.env.OCR_TEXT_THRESHOLD || 100); // chars/page

const SUPPORTED = new Set(['.docx', '.doc', '.pdf', '.xlsx', '.xls', '.csv', '.txt', '.md']);

// ---------------------------------------------------------------------------
// Turndown — tuned for Ukrainian legal docs (atx headings, dash bullets,
// pipe-tables via the GFM plugin, page breaks → horizontal rules).
// ---------------------------------------------------------------------------
const td = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  hr: '---',
  strongDelimiter: '**',
  emDelimiter: '_',
  linkStyle: 'inlined',
  linkReferenceStyle: 'full',
});
td.use(gfm);
td.addRule('pageBreakHr', {
  filter: (node) =>
    node.nodeName === 'HR' ||
    (node.style && node.style.pageBreakBefore === 'always'),
  replacement: () => '\n\n---\n\n',
});

// ---------------------------------------------------------------------------
// OCR worker — kept warm for the life of the process. Tesseract.js
// downloads the `ukr+eng` traineddata on first use; the warm-up call
// in `start()` triggers that download so the first real request isn't
// dominated by a model download.
// ---------------------------------------------------------------------------
let ocrWorker = null;
async function ensureOcrWorker() {
  if (ocrWorker) return ocrWorker;
  ocrWorker = await createWorker(['ukr', 'eng']);
  return ocrWorker;
}

function wordCount(text) {
  if (!text) return 0;
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// Per-format converters. Each returns { markdown, meta }. `meta.format` is
// the canonical kind ('docx'/'pdf'/'pdf-ocr'/'xlsx'/'doc'/'csv'/'txt').
// ---------------------------------------------------------------------------

async function convertDocx(buf, name) {
  const { value: html, messages } = await mammoth.convertToHtml({ buffer: buf });
  const markdown = td.turndown(html);
  return {
    markdown,
    meta: {
      title: path.basename(name, path.extname(name)),
      word_count: wordCount(markdown),
      format: 'docx',
      warnings: messages?.length ? messages.map((m) => m.message) : undefined,
    },
  };
}

async function convertDoc(buf, name) {
  const extractor = new WordExtractor();
  const ext = await extractor.extract(buf);
  const text = (ext.getBody() || '').trim();
  // Old .doc files lose paragraph structure aggressively; preserve double
  // newlines as paragraph breaks rather than collapsing to single lines.
  const md = text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean).join('\n\n');
  return {
    markdown: md,
    meta: {
      title: path.basename(name, path.extname(name)),
      word_count: wordCount(md),
      format: 'doc',
    },
  };
}

async function pagesFromPdf2json(buf) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, true);
    parser.on('pdfParser_dataError', (err) => reject(err?.parserError || err));
    parser.on('pdfParser_dataReady', () => {
      try {
        const raw = parser.getRawTextContent();
        const pages = raw.split('----------------Page (')
          .filter((p) => p.includes(') Break----------------'))
          .map((p) => p.split(') Break----------------')[1] || '');
        resolve(pages);
      } catch (e) { reject(e); }
    });
    parser.parseBuffer(buf);
  });
}

async function convertPdf(buf, name) {
  // pdf-parse gets us a fast text extraction (no positions). For text PDFs
  // this is fine. For scans, the extracted text is mostly empty and we
  // fall through to OCR per page via pdf2json.
  let parsed;
  try { parsed = await pdfParse(buf); } catch (_e) { parsed = null; }
  const text = (parsed?.text || '').trim();
  const numPages = parsed?.numpages || 0;
  const avgPerPage = numPages > 0 ? text.length / numPages : text.length;

  if (text && avgPerPage >= OCR_TEXT_THRESHOLD) {
    const md = text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean).join('\n\n');
    return {
      markdown: md,
      meta: {
        title: parsed?.info?.Title || path.basename(name, path.extname(name)),
        pages: numPages,
        word_count: wordCount(md),
        format: 'pdf',
      },
    };
  }

  // Looks like a scan — try OCR. We render via pdf2json text extraction
  // (still no images) and fall back to tesseract on the raw buffer for
  // each page. pdf2json's text is also empty for true scans, so the OCR
  // path will not get richer without rasterizing — best we can do without
  // pulling in a Cairo/Poppler dep.
  let ocrPages = [];
  try {
    const worker = await ensureOcrWorker();
    // tesseract.js can read the PDF directly; the worker rasterizes pages
    // internally. We pass the buffer with a PDF content type.
    const { data } = await worker.recognize(buf);
    const ocrText = (data?.text || '').trim();
    if (ocrText) ocrPages = ocrText.split(/\f|\n{3,}/);
  } catch (e) {
    // OCR failed — fall back to whatever pdf-parse gave us (probably empty).
    console.error('[converter] OCR failed:', e?.message || e);
  }

  const ocrJoined = ocrPages.length > 0 ? ocrPages.join('\n\n') : text;
  return {
    markdown: ocrJoined,
    meta: {
      title: path.basename(name, path.extname(name)),
      pages: numPages || ocrPages.length || undefined,
      word_count: wordCount(ocrJoined),
      format: ocrPages.length > 0 ? 'pdf-ocr' : 'pdf',
    },
  };
}

function sheetToMarkdownTable(rows) {
  if (!rows || rows.length === 0) return '';
  const header = rows[0].map((c) => String(c ?? '').trim());
  const widths = header.map((h) => Math.max(h.length, 3));
  const body = rows.slice(1);
  const headerRow = '| ' + header.join(' | ') + ' |';
  const sepRow = '| ' + widths.map(() => '---').join(' | ') + ' |';
  const bodyRows = body.map((r) => '| ' + header.map((_, i) => String(r[i] ?? '').replace(/\|/g, '\\|').trim()).join(' | ') + ' |');
  return [headerRow, sepRow, ...bodyRows].join('\n');
}

async function convertXlsx(buf, name) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    if (!rows.length) continue;
    parts.push(`## ${sheetName}\n\n${sheetToMarkdownTable(rows)}`);
  }
  const md = parts.join('\n\n');
  return {
    markdown: md,
    meta: {
      title: path.basename(name, path.extname(name)),
      word_count: wordCount(md),
      format: 'xlsx',
    },
  };
}

async function convertCsv(buf, name) {
  const records = csvParse(buf, { skip_empty_lines: true });
  const md = sheetToMarkdownTable(records);
  return {
    markdown: md,
    meta: {
      title: path.basename(name, path.extname(name)),
      word_count: wordCount(md),
      format: 'csv',
    },
  };
}

async function convertText(buf, name, fmt) {
  const md = buf.toString('utf8');
  return {
    markdown: md,
    meta: {
      title: path.basename(name, path.extname(name)),
      word_count: wordCount(md),
      format: fmt,
    },
  };
}

async function dispatch(buf, name) {
  const ext = path.extname(name).toLowerCase();
  if (!SUPPORTED.has(ext)) {
    const err = new Error(`Unsupported file type: ${ext}`);
    err.statusCode = 415;
    throw err;
  }
  switch (ext) {
    case '.docx': return convertDocx(buf, name);
    case '.doc':  return convertDoc(buf, name);
    case '.pdf':  return convertPdf(buf, name);
    case '.xlsx':
    case '.xls':  return convertXlsx(buf, name);
    case '.csv':  return convertCsv(buf, name);
    case '.txt':  return convertText(buf, name, 'txt');
    case '.md':   return convertText(buf, name, 'md');
    default: {
      const err = new Error(`Unsupported file type: ${ext}`);
      err.statusCode = 415;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected field "file").' });
    const { buffer, originalname } = req.file;
    const result = await dispatch(buffer, originalname);
    res.json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[converter] /convert failed:', err);
    res.status(status).json({ error: err.message || String(err) });
  }
});

// Multer rejects oversized files via an error middleware; surface a clean 413.
app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `Файл перевищує ${Math.floor(MAX_BYTES / (1024 * 1024))} МБ — зменшіть розмір і спробуйте ще раз.`,
    });
  }
  res.status(500).json({ error: err?.message || 'Internal error' });
});

async function start() {
  // Best-effort OCR warm-up so the first real request isn't a 20s download.
  try {
    await ensureOcrWorker();
    console.log('[converter] OCR worker ready (ukr+eng)');
  } catch (e) {
    console.error('[converter] OCR worker warm-up failed:', e?.message || e);
  }
  app.listen(PORT, () => console.log(`[converter] listening on :${PORT}`));
}

start();
