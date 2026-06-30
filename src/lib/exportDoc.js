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

function sectionsToMarkdown(sections) {
  return sections.map((s) => {
    const head = [s.number, s.title].filter(Boolean).join(' ');
    return (head ? `## ${head}\n\n` : '') + (s.text || '');
  }).join('\n\n---\n\n');
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

export function downloadMd(sections, name) {
  if (!Array.isArray(sections) || sections.length === 0) return;
  const text = sectionsToMarkdown(sections);
  triggerDownload(
    new Blob([text], { type: 'text/markdown;charset=utf-8' }),
    safeBase(name) + '-edited.md',
  );
}

export function downloadTxt(sections, name) {
  if (!Array.isArray(sections) || sections.length === 0) return;
  const text = sectionsToText(sections);
  triggerDownload(
    new Blob([text], { type: 'text/plain;charset=utf-8' }),
    safeBase(name) + '-edited.txt',
  );
}

export async function downloadDocx(sections, name) {
  if (!Array.isArray(sections) || sections.length === 0) return;
  // Dynamic import — the docx package is ~500 KB minified and most users
  // never click this option. Loading it on-demand keeps the initial JS
  // bundle small.
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');

  const children = [];
  for (const s of sections) {
    const head = [s.number, s.title].filter(Boolean).join(' ');
    if (head) {
      children.push(new Paragraph({
        text: head,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 320, after: 120 },
      }));
    }
    const body = (s.text || '').trim();
    if (!body) continue;
    for (const para of body.split(/\n{2,}/)) {
      const clean = para.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1').trim();
      if (!clean) continue;
      children.push(new Paragraph({
        children: [new TextRun({ text: clean, size: 24 })], // 12pt
        spacing: { after: 160 },
      }));
    }
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

/**
 * Open the browser print dialog. The accompanying @media print rules in
 * markdownDoc.css hide the sidebar / panel / toolbar so the user gets a
 * clean document. "Save as PDF" from the print dialog completes the
 * export — no PDF library required.
 */
export function printAsPdf() {
  window.print();
}
