/* ============================================================
   AG Lex — shared label / avatar helpers used across screens.
   ============================================================ */
import { LX } from '../data/lx';

export function roleLabel(t, r) {
  return { partner: t.rolePartner, senior: t.roleSenior, lawyer: t.roleLawyer, paralegal: t.roleParalegal, admin: t.roleAdmin }[r] || r;
}

export function UserAvatar({ id, size = 28 }) {
  const u = LX.userById[id];
  if (!u) return null;
  return <span className="ua" style={{ width: size, height: size, background: `oklch(0.58 0.14 ${u.color})`, fontSize: size * 0.4 }} title={u.name}>{u.initials}</span>;
}

export const prioColor = { high: 'var(--risk-high)', med: 'var(--risk-med)', low: 'var(--risk-low)' };
