/* ============================================================
   useLegislation — data layer for the «Законодавство» library.

   Owns: sources list, selected source, paginated article list (with
   search mode), selected article + reading-pane content. Each list
   page response is cached by `source|q|offset` so flipping between
   sources or paging back doesn't re-fetch.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { typeOf } from './sourceMeta';

const PAGE_SIZE = 50;

function listCacheKey(source, q, offset) {
  return `${source}|${q || ''}|${offset}`;
}

export function useLegislation() {
  const [sources, setSources] = useState([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [selectedSource, setSelectedSource] = useState(null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [articles, setArticles] = useState([]);
  const [mode, setMode] = useState('list');
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [selectedArticleId, setSelectedArticleId] = useState(null);
  const [selectedArticle, setSelectedArticle] = useState(null);
  const [articleLoading, setArticleLoading] = useState(false);

  // Small Map cache keyed by source|q|offset → { items, total, mode }.
  // Lives across selection changes but resets on a hard reload — fine,
  // codex content is static within a session.
  const listCache = useRef(new Map());

  // 1. Sources list on mount.
  useEffect(() => {
    let cancelled = false;
    setSourcesLoading(true);
    api.codex.sources()
      .then(rows => {
        if (cancelled) return;
        const list = Array.isArray(rows) ? rows : [];
        setSources(list);
        // Default selection: first source by row count (server already
        // orders DESC by count). User can pick another from the rail.
        if (list.length && !selectedSource) setSelectedSource(list[0].source);
      })
      .catch(() => { if (!cancelled) setSources([]); })
      .finally(() => { if (!cancelled) setSourcesLoading(false); });
    return () => { cancelled = true; };
    // selectedSource intentionally NOT a dep — we only seed it once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Article list whenever {source, query, offset} change.
  const loadList = useCallback((source, q, off) => {
    if (!source) return Promise.resolve();
    const key = listCacheKey(source, q, off);
    const cached = listCache.current.get(key);
    if (cached) {
      setArticles(off === 0 ? cached.items : prev => prev.concat(cached.items));
      setTotal(cached.total);
      setMode(cached.mode);
      return Promise.resolve();
    }
    setListLoading(true);
    return api.codex.articles({ source, q, limit: PAGE_SIZE, offset: off })
      .then(res => {
        const payload = {
          items: res.items || [],
          total: res.total || 0,
          mode: res.mode || (q ? 'search' : 'list'),
        };
        listCache.current.set(key, payload);
        setMode(payload.mode);
        setTotal(payload.total);
        setArticles(off === 0 ? payload.items : prev => prev.concat(payload.items));
      })
      .catch(() => {
        if (off === 0) setArticles([]);
      })
      .finally(() => setListLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedSource) return;
    setOffset(0);
    setSelectedArticleId(null);
    setSelectedArticle(null);
    loadList(selectedSource, query, 0);
  }, [selectedSource, query, loadList]);

  const loadMore = useCallback(() => {
    if (mode !== 'list') return; // search mode doesn't paginate
    const next = offset + PAGE_SIZE;
    if (next >= total) return;
    setOffset(next);
    loadList(selectedSource, query, next);
  }, [mode, offset, total, selectedSource, query, loadList]);

  const hasMore = mode === 'list' && offset + PAGE_SIZE < total;

  // 3. Reading pane on selection.
  useEffect(() => {
    if (selectedArticleId == null) {
      setSelectedArticle(null);
      return;
    }
    let cancelled = false;
    setArticleLoading(true);
    api.codex.article(selectedArticleId)
      .then(row => { if (!cancelled) setSelectedArticle(row); })
      .catch(() => { if (!cancelled) setSelectedArticle(null); })
      .finally(() => { if (!cancelled) setArticleLoading(false); });
    return () => { cancelled = true; };
  }, [selectedArticleId]);

  // 4. Deep-link from citation cards in the AI-lawyer chat.
  // ChatWindow stores `{articleNumber, filter}` in localStorage and
  // routes here. We try the sources mapped by the chat's filter id,
  // find the first article with that number, open it.
  const consumeJumpHint = useCallback(async () => {
    if (!sources.length) return;
    let raw;
    try { raw = localStorage.getItem('aglex_legal_jump'); } catch { return; }
    if (!raw) return;
    let hint;
    try { hint = JSON.parse(raw); } catch { return; }
    if (!hint || !hint.articleNumber) return;
    const FILTER_MAP = {
      code: ['ЦКУ', 'ГКУ', 'КУпАП', 'КК', 'КЗпП', 'ПКУ', 'СКУ'],
      law:  ['ЦКУ', 'ГКУ', 'КУпАП', 'КК', 'КЗпП', 'ПКУ', 'СКУ'],
      eu:   ['EU_GDPR', 'EU_DSA', 'EU_DMA'],
      case: null,
      all:  null,
    };
    const candidates = FILTER_MAP[hint.filter] || sources.map(s => s.source);
    const target = String(hint.articleNumber).trim();
    try {
      for (const src of candidates) {
        // Use search-mode q to narrow without paging — title or content
        // typically references the number too.
        const res = await api.codex.articles({ source: src, q: target, limit: 25 });
        const hit = (res.items || []).find(a =>
          String(a.article_number).trim() === target
          || String(a.article_number).trim().endsWith(' ' + target),
        );
        if (hit) {
          // Clear any active type chip — otherwise the citation can land on
          // a source the user has filtered out and they see nothing.
          setTypeFilter('all');
          setSelectedSource(src);
          setQuery('');
          setSelectedArticleId(hit.id);
          break;
        }
      }
    } finally {
      try { localStorage.removeItem('aglex_legal_jump'); } catch { /* fine */ }
    }
  }, [sources]);

  useEffect(() => {
    if (sources.length) consumeJumpHint();
  }, [sources, consumeJumpHint]);

  const selectArticle = useCallback((id) => setSelectedArticleId(id), []);

  // Derived: sources visible under the current type filter + aggregate counters.
  const visibleSources = useMemo(() => (
    typeFilter === 'all' ? sources : sources.filter(s => typeOf(s.source) === typeFilter)
  ), [sources, typeFilter]);

  const totalSources = sources.length;
  const indexedSources = useMemo(() => (
    sources.filter(s => (s.indexed_count || 0) > 0).length
  ), [sources]);

  // The set of types actually present in the loaded sources — used by the UI
  // to render only chips that have content, in a stable order.
  const availableTypes = useMemo(() => {
    const seen = new Set(sources.map(s => typeOf(s.source)));
    return ['all', ...['code', 'eu', 'other'].filter(k => seen.has(k))];
  }, [sources]);

  // If the active filter hides the current selection, jump to the first
  // visible source (or clear). Reading-pane state is wiped by the
  // selectedSource effect already.
  useEffect(() => {
    if (typeFilter === 'all') return;
    if (!selectedSource) return;
    if (typeOf(selectedSource) === typeFilter) return;
    setSelectedSource(visibleSources[0]?.source || null);
  }, [typeFilter, selectedSource, visibleSources]);

  return useMemo(() => ({
    sources,
    visibleSources,
    sourcesLoading,
    selectedSource,
    setSelectedSource,
    typeFilter,
    setTypeFilter,
    availableTypes,
    totalSources,
    indexedSources,
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
  }), [
    sources, visibleSources, sourcesLoading, selectedSource, typeFilter,
    availableTypes, totalSources, indexedSources, query, articles, mode, total,
    listLoading, hasMore, loadMore, selectedArticleId, selectedArticle,
    articleLoading, selectArticle,
  ]);
}
