/* ============================================================
   ReadingPane — right column of the library. Article number
   badge + title header, then the full body. Empty state when
   nothing selected.
   ============================================================ */
import { Icon } from '../../ui/Icon';

function renderBody(content) {
  if (!content) return null;
  // Articles in the codex use a flat "1. ...\n\n2. ...\n\n" structure;
  // split on blank lines and render each chunk as a paragraph so the
  // reading pane gets proper vertical rhythm without us inventing
  // markdown.
  const paragraphs = content
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);
  return paragraphs.map((p, i) => (
    <p key={i} className="lex-read-p">{p}</p>
  ));
}

export function ReadingPane({ article, loading, sourceLabel, t }) {
  if (loading) {
    return (
      <article className="lex-reader" aria-busy="true">
        <div className="lex-reader-empty">
          <Icon name="book" size={28} />
          <div>{t.lawLoading || 'Завантаження…'}</div>
        </div>
      </article>
    );
  }
  if (!article) {
    return (
      <article className="lex-reader">
        <div className="lex-reader-empty">
          <Icon name="book" size={32} />
          <h2 className="lex-reader-empty-t">{t.legalPickArticle || 'Оберіть статтю'}</h2>
          <p className="lex-reader-empty-s">
            {t.legalPickArticleSub || 'Виберіть джерело зліва і натисніть на статтю, щоб прочитати повний текст.'}
          </p>
        </div>
      </article>
    );
  }
  return (
    <article className="lex-reader" aria-label={article.title || article.article_number}>
      <header className="lex-reader-head">
        <span className="lex-reader-badge">{sourceLabel || article.source}</span>
        <span className="lex-reader-num">{article.article_number}</span>
      </header>
      <h1 className="lex-reader-t">{article.title || (t.legalNoTitle || 'Без назви')}</h1>
      <div className="lex-reader-body">
        {renderBody(article.content)}
      </div>
    </article>
  );
}
