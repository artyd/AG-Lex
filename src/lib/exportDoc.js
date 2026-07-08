import { authHeaders } from './auth';

/* ============================================================
   exportDoc — client-side export for edited contract sections.

   Formats:
     md   — markdown with `## heading` per section, sections
            separated by ---
     txt  — clean plain text, headings underlined with ─, markdown
            syntax stripped, list bullets normalised to •
     docx — generated client-side via the `docx` package (dynamic
            import keeps the ~500 KB lib out of the main bundle
            until the user actually picks the Word format)
     print — opens the browser print dialog; the print CSS in
            markdownDoc.css hides the chrome so "Save as PDF" from
            the dialog gives a clean export. No third-party PDF lib.
   ============================================================ */

function sectionsToText(sections) {
  return sections.map((s) => {
    const head = [s.number, s.title].filter(Boolean).join(' ');
    const body = (s.text || '')
      .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/#{1,6}\s+/g, '')
      .replace(/^[-*+]\s+/gm, '• ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .trim();
    return (head ? head + '\n' + '─'.repeat(Math.min(head.length, 60)) + '\n\n' : '') + body;
  }).join('\n\n\n');
}

/* Различаем top-level секции («1. ПРЕДМЕТ», «Стаття 5», «п. 3») и
   суб-пункты («1.1», «2.3»). Top-level → H2 (bold в редакторе),
   суб-пункты → обычный параграф с «N.M.» в начале — как в исходном
   PDF-договоре, где 1.1 набран тем же 10pt regular, что и body-текст. */
const _SUBPOINT_NUMBER_RE = /^\d+(?:\.\d+)+$/;

export function sectionsToMarkdown(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return '';
  return sections.map((s) => {
    const num = (s.number || '').trim();
    const head = [num, s.title].filter(Boolean).join(' ');
    if (!head) return s.text || '';
    if (_SUBPOINT_NUMBER_RE.test(num)) {
      // «1.1» стиль — inline-параграф, чтобы редактор не рисовал bold H2
      return (s.text ? `${head} ${s.text}` : head);
    }
    return `## ${head}\n\n${s.text || ''}`;
  }).join('\n\n');
}

/* Ужать markdown до чистого текста для .txt-экспорта. Логика повторяет
   sectionsToText inline: убираем ** * ` ~~ и заголовочный `#`, а маркеры
   списка нормализуем в «•». */
function markdownToPlain(md) {
  return (md || '')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '• ')
    .replace(/^---+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Strip filesystem-hostile chars but keep cyrillic + latin + dash + space.
function safeBase(name) {
  return ((name || 'contract')
    .replace(/\.[^.]+$/, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'contract');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* Ниже пары «string-based» / «sections-based» вариантов. Основная ветка
   аналитического экрана уже держит доку как markdown-строку (после
   миграции на CodeMirror 6), поэтому *String-варианты — быстрый путь.
   Массивные варианты оставлены для legacy-caller'ов (Library preview,
   старый MarkdownDoc-путь), они просто гоняют массив через
   sectionsToMarkdown и передают дальше. */

export function downloadMdString(md, name) {
  if (typeof md !== 'string' || md.length === 0) return;
  triggerDownload(
    new Blob([md], { type: 'text/markdown;charset=utf-8' }),
    safeBase(name) + '-edited.md',
  );
}

export function downloadMd(sections, name) {
  if (typeof sections === 'string') return downloadMdString(sections, name);
  if (!Array.isArray(sections) || sections.length === 0) return;
  downloadMdString(sectionsToMarkdown(sections), name);
}

export function downloadTxtString(md, name) {
  if (typeof md !== 'string' || md.length === 0) return;
  triggerDownload(
    new Blob([markdownToPlain(md)], { type: 'text/plain;charset=utf-8' }),
    safeBase(name) + '-edited.txt',
  );
}

export function downloadTxt(sections, name) {
  if (typeof sections === 'string') return downloadTxtString(sections, name);
  if (!Array.isArray(sections) || sections.length === 0) return;
  const text = sectionsToText(sections);
  triggerDownload(
    new Blob([text], { type: 'text/plain;charset=utf-8' }),
    safeBase(name) + '-edited.txt',
  );
}

/* Клиентский MD→DOCX. Стилистика синхронизирована с редактором
   (Verdana 10pt, headings 11/12/14pt bold, justify body) и с
   бэкендом `_markdown_to_docx_bytes` в export_routes.py — так
   скачанный файл, что через client, что через `/api/export/pdf`,
   выглядит идентично тому, что юрист правил на экране.
   docx-lib меряет size в half-points: 10pt → 20, 11pt → 22, ... */
const FONT_NAME = 'Verdana';
const HEADING_HALF_PT = { 1: 28, 2: 22, 3: 24, 4: 22, 5: 22, 6: 22 };
const BODY_HALF_PT = 20;

export async function downloadDocxString(md, name) {
  if (typeof md !== 'string' || md.length === 0) return;
  // Dynamic import — the docx package is ~500 KB minified.
  const { Document, Packer, Paragraph, TextRun, AlignmentType } = await import('docx');

  const children = [];
  const blocks = md.split(/\n{2,}/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    if (/^---+$/.test(block)) continue; // горизонтальная линия

    const headMatch = block.match(/^(#{1,6})\s+(.+)$/m);
    if (headMatch && headMatch.index === 0) {
      const level = Math.min(headMatch[1].length, 6);
      const size = HEADING_HALF_PT[level] || BODY_HALF_PT;
      children.push(new Paragraph({
        alignment: level === 1 ? AlignmentType.CENTER : (level === 3 ? AlignmentType.CENTER : AlignmentType.LEFT),
        spacing: { before: 240, after: 120 },
        children: [new TextRun({
          text: headMatch[2].trim(),
          bold: true,
          size,
          font: FONT_NAME,
        })],
      }));
      const rest = block.slice(headMatch[0].length).trim();
      if (!rest) continue;
      const clean = rest.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1').trim();
      if (clean) {
        children.push(new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: 120 },
          children: [new TextRun({ text: clean, size: BODY_HALF_PT, font: FONT_NAME })],
        }));
      }
      continue;
    }

    const clean = block.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1').trim();
    if (!clean) continue;
    children.push(new Paragraph({
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 120 },
      children: [new TextRun({ text: clean, size: BODY_HALF_PT, font: FONT_NAME })],
    }));
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: FONT_NAME, size: BODY_HALF_PT } },
      },
    },
    sections: [{ properties: {}, children }],
  });

  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, safeBase(name) + '-edited.docx');
}

export async function downloadDocx(sections, name) {
  if (typeof sections === 'string') return downloadDocxString(sections, name);
  if (!Array.isArray(sections) || sections.length === 0) return;
  return downloadDocxString(sectionsToMarkdown(sections), name);
}

/**
 * Open the browser print dialog. The accompanying @media print rules in
 * markdownDoc.css hide the sidebar / panel / toolbar so the user gets a
 * clean document. "Save as PDF" from the print dialog completes the
 * export — no PDF library required.
 */
export function printAsPdf() {
  window.print();
}

/* ============================================================
   Server-side export: MD → DOCX → PDF via soffice.
   Client MD→DOCX (downloadDocxString) стрипит inline runs; серверный
   pipeline тоже (см. legal_app/backend/export_routes.py), но даёт
   printer-ready PDF без браузерного print-dialog. Скачивание идёт
   стандартным blob-паттерном.
   ============================================================ */

async function _postExport(path, md, name) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ markdown: md, filename: safeBase(name) }),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch (_e) { /* non-json */ }
    throw new Error(`Export failed: ${detail}`);
  }
  return res.blob();
}

export async function downloadPdfFromServer(md, name) {
  if (typeof md !== 'string' || md.length === 0) return;
  const blob = await _postExport('/api/export/pdf', md, name);
  triggerDownload(blob, safeBase(name) + '-edited.pdf');
}

export async function downloadDocxFromServer(md, name) {
  if (typeof md !== 'string' || md.length === 0) return;
  const blob = await _postExport('/api/export/docx', md, name);
  triggerDownload(blob, safeBase(name) + '-edited.docx');
}
