/* ============================================================
   SourceList — left rail of the library. One tile per codex
   source with a FA-solid icon + article count. Selected tile
   gets accent border + tint, mirroring the chat sidebar style.
   ============================================================ */
import { Icon } from '../../ui/Icon';

// Source → human-friendly title + FA icon. Tile order in the rail
// matches whatever the backend returned (DESC by count).
const SOURCE_META = {
  'ЦКУ':     { title: 'Цивільний кодекс', icon: 'scales' },
  'ГКУ':     { title: 'Господарський кодекс', icon: 'briefcase' },
  'КУпАП':   { title: 'КУпАП', icon: 'gavel' },
  'КК':      { title: 'Кримінальний кодекс', icon: 'shield' },
  'КЗпП':    { title: 'Кодекс законів про працю', icon: 'clients' },
  'ПКУ':     { title: 'Податковий кодекс', icon: 'coins' },
  'СКУ':     { title: 'Сімейний кодекс', icon: 'handshake' },
  'EU_GDPR': { title: 'GDPR', icon: 'lock' },
  'EU_DSA':  { title: 'Digital Services Act', icon: 'globe' },
  'EU_DMA':  { title: 'Digital Markets Act', icon: 'globe' },
};

function meta(source) {
  return SOURCE_META[source] || { title: source, icon: 'book' };
}

export function SourceList({ sources, selected, onSelect, loading, t }) {
  if (loading) {
    return (
      <aside className="lex-sources" aria-label={t.legalSources || 'Джерела'}>
        <div className="lex-empty">{t.lawLoading || 'Завантаження…'}</div>
      </aside>
    );
  }
  if (!sources.length) {
    return (
      <aside className="lex-sources" aria-label={t.legalSources || 'Джерела'}>
        <div className="lex-empty">{t.legalNoSources || 'База кодексів порожня.'}</div>
      </aside>
    );
  }
  return (
    <aside className="lex-sources" aria-label={t.legalSources || 'Джерела'}>
      <div className="lex-rail-head">{t.legalSources || 'Джерела'}</div>
      <div className="lex-tiles">
        {sources.map(s => {
          const m = meta(s.source);
          const active = s.source === selected;
          return (
            <button
              key={s.source}
              type="button"
              className={'lex-tile' + (active ? ' lex-tile-on' : '')}
              onClick={() => onSelect(s.source)}
              aria-pressed={active ? 'true' : 'false'}
            >
              <span className="lex-tile-ic" aria-hidden="true">
                <Icon name={m.icon} size={16} />
              </span>
              <span className="lex-tile-body">
                <span className="lex-tile-code">{s.source}</span>
                <span className="lex-tile-title">{m.title}</span>
              </span>
              <span className="lex-tile-n">{s.count}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
