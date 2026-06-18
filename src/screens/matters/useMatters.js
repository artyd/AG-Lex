/* ============================================================
   useMatters — list-level hook for /api/matters.
   Loads from the server, subscribes to realtime case/member events
   for incremental updates, refetches on reconnect.

   The server-side shape is partially flattened (nextDeadline is a
   bare date, members come back via the hydrated GET). `adaptCard`
   normalises rows to the richer local shape the existing components
   already render, so the UI layer doesn't have to know about the
   server/local divergence.
   ============================================================ */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { subscribe } from '../../lib/realtime';
import { LX } from '../../data/lx';

/** Server card → local card. */
export function adaptCard(row) {
  if (!row) return null;
  const nextDeadline = row.nextDeadline
    ? { date: row.nextDeadline, label: row.nextLabel || '' }
    : null;
  // Normalize legacy Cyrillic types from old seeds so the rest of the UI
  // (which keys colors / icons off the canonical id) keeps working.
  const typeMap = {
    'Корпоративне': 'corporate',
    'Договірне': 'contract',
    'IP / IT': 'ip',
    'Судовий спір': 'litigation',
  };
  const type = typeMap[row.type] || row.type;
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    client: row.client,
    type,
    status: row.status === 'active' ? 'progress' : row.status,
    priority: row.priority || 'med',
    lead: row.lead,
    docs: row.docs || 0,
    openTasks: row.openTasks || 0,
    hours: row.hours || 0,
    color: row.color || 0,
    nextDeadline,
    updatedAt: row.updatedAt || row.updated_at,
  };
}

/** Hydrated case from GET /api/matters/{id} → local detail shape. */
export function adaptDetail(row) {
  if (!row) return null;
  const card = adaptCard(row);
  return {
    ...card,
    summary: row.summary,
    description: row.description,
    opponent: row.opponent,
    court: row.court,
    judge: row.judge,
    outcome: row.outcome,
    result: row.outcome,
    startedAt: row.startedAt || row.started_at,
    closedAt: row.closedAt || row.closed_at,
    members: row.members || [],
    parties: deriveParties(row.parties || [], row.client),
    notes: (row.notes || []).map(n => ({
      id: n.id,
      date: (n.created_at || '').slice(0, 10),
      author: n.author_id,
      text: n.text,
    })),
    hearings: row.hearings || [],
    timeline: (row.timeline || []).map(it => ({
      id: it.id,
      date: (it.created_at || '').slice(0, 10),
      kind: it.action === 'case.updated' ? 'note' : (it.field || 'note'),
      text: it.new_value || it.action,
    })),
    keyFacts: [],
  };
}

function deriveParties(rows, fallbackClient) {
  // The matters detail UI expects {client, clientRep, opponent, opponentRep}
  // — flatten the case_parties list into that shape, with the row's own
  // `client` column as the default for the client field.
  const out = { client: fallbackClient, clientRep: null, opponent: null, opponentRep: null };
  for (const p of rows) {
    if (p.role === 'client') out.client = p.name;
    else if (p.role === 'clientRep') out.clientRep = p.name;
    else if (p.role === 'opponent') out.opponent = p.name;
    else if (p.role === 'opponentRep') out.opponentRep = p.name;
  }
  return out;
}

// Stages a litigation moves through. Index is what dispute cards highlight
// in the progress strip — 0 done, 1 done, 2 = current, 3 = future, etc.
export const LIT_STAGES = ['open', 'prep', 'trial', 'decision'];

function defaultStageFromStatus(m) {
  if (m.status === 'closed') return 3;        // Decision
  if (m.status === 'court') return 2;         // Trial
  if (m.status === 'waiting' || m.status === 'stuck') return 1; // Preparatory
  return 0;                                   // Filing
}

/** Matter → dispute card model. Safe defaults so a freshly-routed-to-court
 *  case (no court fields yet) still renders — with a CTA to fill them in. */
export function adaptDispute(m) {
  if (!m) return null;
  return {
    id: m.id,
    code: m.code,
    title: m.title,
    client: m.client,
    lead: m.lead,
    matterStatus: m.status,
    caseNumber:  m.caseNumber || m.number || null,
    court:       m.court || (m.parties && m.parties.court) || null,
    judge:       m.judge || null,
    opponent:    m.opponent || (m.parties && m.parties.opponent) || null,
    role:        m.role || 'Відповідач',
    instance:    m.instance || 'first',
    claimAmount: m.claimAmount ?? m.amount ?? null,
    nextHearing: m.nextHearing
      || (m.next && m.next.date)
      || (m.nextDeadline && m.nextDeadline.kind === 'court' && m.nextDeadline.date)
      || null,
    stageIndex:  Number.isInteger(m.litStage) ? m.litStage : defaultStageFromStatus(m),
    outcome:     m.outcome || m.result || null,
    closedAt:    m.closedAt || null,
    hearings:    m.hearings || [],
  };
}

/** A dispute is any matter that is currently in court or whose type is
 *  litigation (so freshly-created litigation cases also surface here even
 *  before the lawyer flips the status). Pure derivation — no side effects. */
export function selectDisputes(matters) {
  if (!Array.isArray(matters)) return [];
  return matters
    .filter(m => m.status === 'court' || m.type === 'litigation' || m.status === 'closed' && m.type === 'litigation')
    .map(adaptDispute);
}

/** Hook: list of matters scoped to the current user (server-enforced). */
export function useMatters() {
  const [matters, setMatters] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const reload = () => {
    api.matters.list()
      .then(rows => Array.isArray(rows) ? rows.map(adaptCard) : [])
      .then(rows => { setMatters(rows); setLoaded(true); })
      .catch(() => {
        // Offline fallback to the prototype list so the dev demo isn't
        // bricked by an absent backend. Skipped after the first server
        // hit so we don't shadow real data.
        if (!loaded) setMatters((LX.matters || []).map(m => ({ ...m, status: m.status === 'active' ? 'progress' : m.status })));
        setLoaded(true);
      });
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  // Realtime: cards refresh when a case is created / updated and when
  // membership changes (gain or lose visibility). On reconnect we reload
  // the whole list to close any gap.
  useEffect(() => {
    const u1 = subscribe('case.created', reload);
    const u2 = subscribe('case.updated', (ev) => {
      const fields = ev.data?.fields || {};
      setMatters(ms => ms.map(m => m.id === ev.case_id ? { ...m, ...adaptCard({ ...m, ...fields }) } : m));
    });
    const u3 = subscribe('member.added', reload);
    const u4 = subscribe('member.removed', reload);
    const u5 = subscribe('realtime:reconnected', reload);
    return () => { u1(); u2(); u3(); u4(); u5(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { matters, setMatters, reload, loaded };
}

/** Hook: hydrated detail for one case, refreshed on every relevant event. */
export function useMatterDetail(caseId) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = () => {
    if (!caseId) return;
    setLoading(true);
    api.matters.get(caseId)
      .then(row => { setDetail(adaptDetail(row)); setLoading(false); })
      .catch(() => { setDetail(null); setLoading(false); });
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [caseId]);

  useEffect(() => {
    if (!caseId) return;
    const filter = (ev) => ev.case_id === caseId;
    const u1 = subscribe('case.updated', reload, { filter });
    const u2 = subscribe('note.added', reload, { filter });
    const u3 = subscribe('hearing.added', reload, { filter });
    const u4 = subscribe('party.added', reload, { filter });
    const u5 = subscribe('task.added', reload, { filter });
    const u6 = subscribe('member.added', reload, { filter });
    const u7 = subscribe('member.removed', reload, { filter });
    const u8 = subscribe('realtime:reconnected', reload);
    return () => { u1(); u2(); u3(); u4(); u5(); u6(); u7(); u8(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  return { detail, setDetail, reload, loading };
}
