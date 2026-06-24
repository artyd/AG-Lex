/* ============================================================
   ArticleList — middle column of the library. Paginated rows
   in browse mode ("Завантажити ще" button at the bottom),
   ranked rows with snippets in search mode.
   ============================================================ */
import { Icon } from '../../ui/Icon';

export function ArticleList({
  articles,
  mode,
  total,
  loading,
  hasMore,
  onLoadMore,
  selectedId,
  onSelect,
  query,
  t,
}) {
  const isSearch = mode === 'search';

  return (
    <section className="lex-articles" aria-label={t.legalArticles || 'Статті'}>
      <header className="lex-list-head">
        <span className="lex-list-h-t">
          {isSearch ? (t.legalSearchResults || 'Результати пошуку') : (t.legalArticles || 'Статті')}
        </span>
        <span className="lex-list-h-n">{total}</span>
      </header>

      {!articles.length && !loading ? (
        <div className="lex-empty">
          {isSearch
            ? `${t.legalNoMatches || 'Нічого не знайдено за запитом'} «${query}»`
            : (t.legalNoArticles || 'Жодної статті в цьому джерелі.')}
        </div>
      ) : null}

      <ol className="lex-list">
        {articles.map(a => (
          <li key={a.id}>
            <button
              type="button"
              className={'lex-row' + (a.id === selectedId ? ' lex-row-on' : '')}
              onClick={() => onSelect(a.id)}
            >
              <span className="lex-row-num">{a.article_number}</span>
              <span className="lex-row-body">
                <span className="lex-row-title">{a.title || (t.legalNoTitle || 'Без назви')}</span>
                {a.snippet ? (
                  <span className="lex-row-snippet">{a.snippet}…</span>
                ) : null}
              </span>
              <Icon name="chevR" size={12} className="lex-row-chev" />
            </button>
          </li>
        ))}
      </ol>

      {loading && articles.length === 0 ? (
        <div className="lex-empty">{t.lawLoading || 'Завантаження…'}</div>
      ) : null}

      {hasMore ? (
        <div className="lex-more">
          <button
            type="button"
            className="lex-more-btn"
            onClick={onLoadMore}
            disabled={loading}
          >
            {loading ? (t.lawLoading || 'Завантаження…') : (t.legalLoadMore || 'Завантажити ще')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
