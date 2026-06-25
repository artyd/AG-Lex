/* ============================================================
   sourceMeta — derives a coarse «type» bucket from the codex
   `source` column. The DB has no per-document type field, so the
   mapping lives here as a single source of truth used by the type
   filter and badge in LegislationLibrary.
   ============================================================ */

const SOURCE_TYPE = {
  'ЦКУ':     'code',
  'ГКУ':     'code',
  'КК':      'code',
  'КЗпП':    'code',
  'ПКУ':     'code',
  'СКУ':     'code',
  'КУпАП':   'code',
  'EU_GDPR': 'eu',
  'EU_DSA':  'eu',
  'EU_DMA':  'eu',
};

export const TYPE_ORDER = ['all', 'code', 'eu', 'other'];

export function typeOf(source) {
  return SOURCE_TYPE[source] || 'other';
}

export function typeLabel(typeKey, t) {
  switch (typeKey) {
    case 'all':   return t.legalTypeAll  || 'Усі';
    case 'code':  return t.legalTypeCode || 'Кодекс';
    case 'eu':    return t.legalTypeEu   || 'Регламент ЄС';
    case 'other': return t.legalTypeOther || 'Інше';
    default:      return typeKey;
  }
}
