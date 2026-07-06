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

export function sectionsToMarkdown(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return '';
  return sections.map((s) => {
    const head = [s.number, s.title].filter(Boolean).join(' ');
    return (head ? `## ${head}\n\n` : '') + (s.text || '');
  }).join('\n\n---\n\n');
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

export async function downloadDocxString(md, name) {
  if (typeof md !== 'string' || md.length === 0) return;
  // Dynamic import — the docx package is ~500 KB minified.
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');

  const children = [];
  // Split by blank lines; keep header-line vs body-line separate.
  const blocks = md.split(/\n{2,}/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    if (/^---+$/.test(block)) continue; // горизонтальная линия из sectionsToMarkdown

    const headMatch = block.match(/^(#{1,6})\s+(.+)$/m);
    if (headMatch && headMatch.index === 0) {
      const level = Math.min(headMatch[1].length, 6);
      const HEADING_MAP = [
        HeadingLevel.HEADING_1, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ];
      children.push(new Paragraph({
        text: headMatch[2].trim(),
        heading: HEADING_MAP[level] || HeadingLevel.HEADING_2,
        spacing: { before: 320, after: 120 },
      }));
      const rest = block.slice(headMatch[0].length).trim();
      if (!rest) continue;
      const clean = rest.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1').trim();
      if (clean) {
        children.push(new Paragraph({
          children: [new TextRun({ text: clean, size: 24 })],
          spacing: { after: 160 },
        }));
      }
      continue;
    }

    const clean = block.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1').trim();
    if (!clean) continue;
    children.push(new Paragraph({
      children: [new TextRun({ text: clean, size: 24 })],
      spacing: { after: 160 },
    }));
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Times New Roman', size: 24 } },
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
