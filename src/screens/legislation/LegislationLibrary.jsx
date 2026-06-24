/* ============================================================
   LegislationLibrary — «Законодавство» tab. Three columns:
   sources rail → article list → reading pane. On <900px the
   layout collapses to a drill-down stack with a back chevron.
   ============================================================ */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { SourceList } from './SourceList';
import { ArticleList } from './ArticleList';
import { ReadingPane } from './ReadingPane';
import { useLegislation } from './useLegislation';
import './legislation.css';

function useIsNarrow(breakpoint = 900) {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = (e) => setNarrow(e.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [breakpoint]);
  return narrow;
}

export function LegislationLibrary({ t }) {
  const {
    sources,
    sourcesLoading,
    selectedSource,
    setSelectedSource,
    query,
    setQuery,
    articles,
    mode,
    total,
    listLoading,
    hasMore,
    loadMore,
    selectedArticleId,
    selectedArticle,
    articleLoading,
    selectArticle,
  } = useLegislation();

  const [searchDraft, setSearchDraft] = useState('');
  const isNarrow = useIsNarrow(900);
  // Drill-down view state for mobile. Driven by user clicks; on desktop
  // unused (all three columns are always visible).
  const [mobileView, setMobileView] = useState('sources');

  // Debounce search input → committed query.
  useEffect(() => {
    const id = setTimeout(() => setQuery(searchDraft.trim()), 250);
    return () => clearTimeout(id);
  }, [searchDraft, setQuery]);

  // Move forward in the drill-down on selection events.
  const handleSelectSource = useCallback((src) => {
    setSelectedSource(src);
    if (isNarrow) setMobileView('list');
  }, [setSelectedSource, isNarrow]);

  const handleSelectArticle = useCallback((id) => {
    selectArticle(id);
    if (isNarrow) setMobileView('reader');
  }, [selectArticle, isNarrow]);

  // When the jump-hint hook lands an article on its own (citation deep-link),
  // jump the mobile view forward too so the user sees the reader, not the rail.
  useEffect(() => {
    if (isNarrow && selectedArticleId) setMobileView('reader');
  }, [isNarrow, selectedArticleId]);

  const sourceLabel = selectedSource || (t.legalSources || 'Джерела');

  // Mobile: render only the current step + a back-chevron header.
  if (isNarrow) {
    return (
      <div className="page lex-page lex-page-mobile">
        <header className="lex-mobile-head">
          {mobileView !== 'sources' ? (
            <button
              type="button"
              className="lex-back"
              onClick={() => setMobileView(mobileView === 'reader' ? 'list' : 'sources')}
              aria-label={t.back || 'Назад'}
            >
              <Icon name="chevR" size={14} style={{ transform: 'rotate(180deg)' }} />
            </button>
          ) : <span className="lex-back lex-back-placeholder" aria-hidden="true" />}
          <h1 className="lex-mobile-t">
            {mobileView === 'sources'
              ? (t.legalTitle || 'Законодавство')
              : mobileView === 'list'
                ? sourceLabel
                : (selectedArticle?.article_number || (t.legalArticles || 'Стаття'))}
          </h1>
        </header>

        {mobileView === 'sources' ? (
          <SourceList
            sources={sources}
            selected={selectedSource}
            loading={sourcesLoading}
            onSelect={handleSelectSource}
            t={t}
          />
        ) : null}

        {mobileView === 'list' ? (
          <>
            <div className="lex-search lex-search-mobile">
              <Icon name="search" size={14} />
              <input
                type="search"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                placeholder={t.legalSearchPh || 'Пошук по статтях…'}
              />
            </div>
            <ArticleList
              articles={articles}
              mode={mode}
              total={total}
              loading={listLoading}
              hasMore={hasMore}
              onLoadMore={loadMore}
              selectedId={selectedArticleId}
              onSelect={handleSelectArticle}
              query={query}
              t={t}
            />
          </>
        ) : null}

        {mobileView === 'reader' ? (
          <ReadingPane
            article={selectedArticle}
            loading={articleLoading}
            sourceLabel={selectedSource}
            t={t}
          />
        ) : null}
      </div>
    );
  }

  // Desktop: three columns side-by-side.
  return (
    <div className="page lex-page">
      <header className="lex-head">
        <div className="lex-head-title">
          <Icon name="library" size={18} />
          <h1 className="lex-title">{t.legalTitle || 'Законодавство'}</h1>
          <span className="lex-head-sub">{t.legalSub || 'Повна база кодексів і регламентів'}</span>
        </div>
        <div className="lex-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder={t.legalSearchPh || 'Пошук по статтях…'}
          />
        </div>
      </header>

      <div className="lex-grid">
        <SourceList
          sources={sources}
          selected={selectedSource}
          loading={sourcesLoading}
          onSelect={handleSelectSource}
          t={t}
        />
        <ArticleList
          articles={articles}
          mode={mode}
          total={total}
          loading={listLoading}
          hasMore={hasMore}
          onLoadMore={loadMore}
          selectedId={selectedArticleId}
          onSelect={handleSelectArticle}
          query={query}
          t={t}
        />
        <ReadingPane
          article={selectedArticle}
          loading={articleLoading}
          sourceLabel={selectedSource}
          t={t}
        />
      </div>
    </div>
  );
}
