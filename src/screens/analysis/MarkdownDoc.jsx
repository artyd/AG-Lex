/* ============================================================
   MarkdownDoc — readable contract view for AnalysisView.

   Replaces the legacy PDF viewer: takes the analyzer's
   `sections: [{number, title, text}]` and renders them as clean
   typography, stripping raw markdown syntax (***, **, ##, ###,
   bullet markers, link/anchor metadata) so the reader sees text
   only — no formatting characters.

   Findings whose `suggest.from` matches a paragraph are wrapped
   in a colored span (text color only, no background) keyed by
   risk level. Hover + click integrate with the right-side panel
   via the same {active, hovered} props AnalysisView already used
   for PDF overlays.
   ============================================================ */
import { useMemo, useRef } from 'react';
import { Icon } from '../../ui/Icon';
import { buildHighlightParts, groupFindingsByClause } from '../../lib/findingHighlight';

/* ---------- Markdown stripper ---------- */
// Removes inline syntax characters but keeps the underlying text. Order
// matters: triple-asterisk before double, double before single.
function stripInlineMd(text) {
  if (!text) return '';
  return text
    .replace(/\[\]\{#n\d+\}/g, '')                  // zakon.rada anchor tokens
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')       // ![alt](src) → alt
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')        // [text](url) → text
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')          // ***x***
    .replace(/___([^_]+)___/g, '$1')                // ___x___
    .replace(/\*\*([^*]+)\*\*/g, '$1')              // **x**
    .replace(/__([^_]+)__/g, '$1')                  // __x__
    .replace(/(?<![*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1') // *x* (avoid mid-word)
    .replace(/(?<![_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1')   // _x_ (avoid mid-word)
    .replace(/`([^`]+)`/g, '$1')                    // `code`
    .replace(/~~([^~]+)~~/g, '$1');                 // ~~strike~~
}

/* ---------- Block parser ----------
   Splits the markdown body into typed blocks so we can render headings,
   lists and paragraphs without the original `#`/`-`/`>` markers leaking
   into the visible text. */
function parseBlocks(text) {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let buf = [];
  const flushPara = () => {
    if (!buf.length) return;
    const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) blocks.push({ kind: 'p', text: stripInlineMd(joined) });
    buf = [];
  };
  let listBuf = null;
  const flushList = () => {
    if (!listBuf || !listBuf.length) { listBuf = null; return; }
    blocks.push({ kind: 'ul', items: listBuf });
    listBuf = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/^﻿/, '');
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ kind: 'h', level: Math.min(6, h[1].length), text: stripInlineMd(h[2]) });
      continue;
    }
    const li = /^\s{0,3}([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      if (!listBuf) listBuf = [];
      listBuf.push(stripInlineMd(li[2]));
      continue;
    }
    const bq = /^\s{0,3}>+\s?(.*)$/.exec(line);
    if (bq) {
      flushPara();
      flushList();
      blocks.push({ kind: 'bq', text: stripInlineMd(bq[1]) });
      continue;
    }
    flushList();
    buf.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

/* ---------- Single paragraph w/ inline highlights ----------
   Tries each finding's suggest.from against the paragraph text. Matches
   become text-color spans; unmatched findings bubble up so the heading
   chip fallback still surfaces them. */
function HighlightedText({ text, findings, hl, consumed }) {
  const { parts, matched } = useMemo(
    () => buildHighlightParts(text, findings),
    [text, findings],
  );
  if (consumed && matched && matched.size) {
    for (const id of matched) consumed.add(id);
  }
  return parts.map((p, i) => {
    if (typeof p === 'string') return <span key={i}>{p}</span>;
    const f = p.f;
    const isActive = hl && hl.active === f.id;
    const isHovered = hl && hl.hovered === f.id;
    return (
      <mark
        key={i}
        ref={(el) => { if (el && hl && hl.segRefs) hl.segRefs.current[f.id] = el; }}
        className={'md-hl md-hl-' + f.level
          + (isActive ? ' md-hl-active' : '')
          + (isHovered ? ' md-hl-hover' : '')
          + (hl && hl.applied && hl.applied[f.id] ? ' md-hl-applied' : '')}
        onMouseEnter={() => hl && hl.setHovered && hl.setHovered(f.id)}
        onMouseLeave={() => hl && hl.setHovered && hl.setHovered(null)}
        onClick={() => hl && hl.onPick && hl.onPick(f.id)}
      >
        {p.matched}
      </mark>
    );
  });
}

/* ---------- One block in a section ---------- */
function Block({ block, findings, hl, consumed }) {
  if (block.kind === 'h') {
    const Tag = `h${Math.min(6, Math.max(2, block.level + 1))}`;
    return <Tag className={'md-h md-h-' + block.level}>{block.text}</Tag>;
  }
  if (block.kind === 'ul') {
    return (
      <ul className="md-ul">
        {block.items.map((it, i) => (
          <li key={i}>
            {findings && findings.length
              ? <HighlightedText text={it} findings={findings} hl={hl} consumed={consumed} />
              : it}
          </li>
        ))}
      </ul>
    );
  }
  if (block.kind === 'bq') {
    return (
      <blockquote className="md-bq">
        {findings && findings.length
          ? <HighlightedText text={block.text} findings={findings} hl={hl} consumed={consumed} />
          : block.text}
      </blockquote>
    );
  }
  return (
    <p className="md-p">
      {findings && findings.length
        ? <HighlightedText text={block.text} findings={findings} hl={hl} consumed={consumed} />
        : block.text}
    </p>
  );
}

/* ---------- Section heading w/ fallback finding chips ---------- */
function SectionHead({ section, fallback, hl, t }) {
  const head = [section.number, section.title].filter(Boolean).join(' ');
  if (!head) return null;
  return (
    <h3 className="md-section-title">
      {head}
      {fallback.map((f, k) => (
        <mark
          key={k}
          ref={(el) => { if (el && hl && hl.segRefs) hl.segRefs.current[f.id] = el; }}
          className={'md-hl-chip md-hl-' + f.level
            + (hl && hl.active === f.id ? ' md-hl-active' : '')
            + (hl && hl.applied && hl.applied[f.id] ? ' md-hl-applied' : '')}
          title={f.title}
          onMouseEnter={() => hl && hl.setHovered && hl.setHovered(f.id)}
          onMouseLeave={() => hl && hl.setHovered && hl.setHovered(null)}
          onClick={() => hl && hl.onPick && hl.onPick(f.id)}
        >
          <Icon name="alert" size={11} /> {f.clause}
        </mark>
      ))}
    </h3>
  );
}

/* ---------- Top-level component ---------- */
export function MarkdownDoc({
  filename,
  sections,
  findings,
  active,
  hovered,
  setActive,
  setHovered,
  applied,            // { [findingId]: true } — toggles md-hl-applied (green) on the matched mark
  t,
}) {
  const segRefs = useRef({});
  const groups = useMemo(() => groupFindingsByClause(findings || []), [findings]);
  const hl = useMemo(() => ({
    active,
    hovered,
    setHovered,
    onPick: (fid) => { if (setActive) setActive(fid); },
    segRefs,
    applied: applied || {},
  }), [active, hovered, setHovered, setActive, applied]);

  const list = Array.isArray(sections) ? sections : [];
  if (list.length === 0) {
    return (
      <div className="md-empty">
        <Icon name="fileText" size={20} />
        <div className="md-empty-t">{t?.docTextUnavailable || 'Текст документа недоступний.'}</div>
        <div className="md-empty-s">
          {t?.docTextUnavailableSub
            || 'Бекенд не повернув розбитий по секціях текст. Завантажте файл ще раз — і документ зʼявиться тут.'}
        </div>
      </div>
    );
  }
  return (
    <article className="md-doc">
      {filename ? <h1 className="md-doc-title">{filename}</h1> : null}
      {list.map((s, i) => {
        const numKey = s.number ? String(s.number).match(/\d+(?:\.\d+)*/)?.[0] || '' : '';
        const sectionFindings = groups.get(numKey) || [];
        const blocks = parseBlocks(s.text || '');
        const consumed = new Set();
        const anchor = s.number
          ? `clause-${String(s.number).replace(/\s+/g, '')}`
          : `clause-i-${i}`;
        const body = blocks.map((b, k) => (
          <Block key={k} block={b}
            findings={sectionFindings.length ? sectionFindings : null}
            hl={hl} consumed={consumed} />
        ));
        const fallback = sectionFindings.filter((f) => !consumed.has(f.id));
        return (
          <section className="md-section" id={anchor} key={i}>
            <SectionHead section={s} fallback={fallback} hl={hl} t={t} />
            {body}
          </section>
        );
      })}
    </article>
  );
}
