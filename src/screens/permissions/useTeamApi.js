/* ============================================================
   useTeamApi — single source of truth for /api/team/*.

   The Team screen (Members + Audit) and the Access screen (RBAC
   matrix) both mount this hook so they share live state. Without
   it, an admin renaming a user on Team would still see the stale
   row on Access until manual refresh.

   Mutations are optimistic with rollback on server reject. Audit
   refresh is fire-and-forget (non-manage users get 403 silently).
   ============================================================ */
import { useCallback, useEffect, useState } from 'react';
import { initialsOf, hueOf } from '../../lib/auth';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../ui/components';
import { LX } from '../../data/lx';

// Backend → display label helpers (lifted verbatim from Knowledge.jsx
// so both screens share one source of truth for audit row formatting).
function auditActionLabel(t, action) {
  switch (action) {
    case 'role_change': return t.actRole || 'Role change';
    case 'invite':      return t.actInvite || 'Invite';
    case 'remove':      return t.actRemove || 'Remove';
    case 'perm_on':     return t.actPermOn || 'Permission on';
    case 'perm_off':    return t.actPermOff || 'Permission off';
    case 'perm_reset':  return t.actReset || 'Reset defaults';
    default:            return action;
  }
}

function formatAuditTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = x => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function decorateMembers(rows) {
  return rows.map(u => ({
    ...u,
    initials: initialsOf(u.name),
    color: hueOf(u.email || u.name) % 360,
    status: 'online',  // presence isn't tracked yet
  }));
}

function decorateAuditFactory(t) {
  return (rows) => rows.map(a => ({
    id: a.id,
    ts: formatAuditTs(a.ts),
    action: auditActionLabel(t, a.action),
    target: a.target,
    whoName: a.actor_name,
    whoColor: hueOf(a.actor_name || '') % 360,
  }));
}

function reportError(e, t, fallbackMsg) {
  if (e instanceof ApiError) {
    if (e.status === 403) toast(t.teamNoManage || 'Forbidden', 'alert');
    else if (e.status === 409) toast(e.message || (t.teamPermLock || 'Last manager'), 'alert');
    else toast(e.message || fallbackMsg, 'alert');
  } else {
    toast(fallbackMsg, 'alert');
  }
}

export function useTeamApi(t, user) {
  // Seed from LX so the UI renders something before the first fetch and
  // when the backend is offline (matches the previous Team behaviour).
  const [members, setMembers] = useState(LX.team);
  const [perms, setPerms] = useState(LX.permissions);
  const [auditLog, setAuditLog] = useState(LX.audit);
  const decorateAudit = decorateAuditFactory(t);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      api.request('/api/team/members'),
      api.request('/api/team/permissions'),
      api.request('/api/team/audit').catch((e) => {
        if (e instanceof ApiError && e.status === 403) return [];
        throw e;
      }),
    ]).then(([m, p, a]) => {
      if (cancelled) return;
      if (m.status === 'fulfilled') setMembers(decorateMembers(m.value));
      if (p.status === 'fulfilled') setPerms(p.value);
      if (a.status === 'fulfilled') setAuditLog(decorateAudit(a.value));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const myRole = (user && user.role) || 'lawyer';
  const manageRow = perms.find(p => p.key === 'manage');
  const canManage = manageRow ? !!manageRow[myRole] : (myRole === 'partner' || myRole === 'admin');

  const refreshAudit = useCallback(async () => {
    try { setAuditLog(decorateAudit(await api.request('/api/team/audit'))); }
    catch (_e) { /* tolerated — non-manage users won't see audit */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeRole = useCallback(async (id, role) => {
    const m = members.find(x => x.id === id);
    if (!m || m.role === role) return;
    const prev = members;
    setMembers(ms => ms.map(x => x.id === id ? { ...x, role } : x));
    try {
      await api.request(`/api/team/members/${id}`, { method: 'PATCH', body: { role } });
      toast(t.teamRoleSaved, 'check');
      refreshAudit();
    } catch (e) {
      setMembers(prev);
      reportError(e, t, t.teamRoleSaved);
    }
  }, [members, t, refreshAudit]);

  const removeMember = useCallback(async (id) => {
    const m = members.find(x => x.id === id);
    if (!m) return;
    if (typeof window !== 'undefined' && !window.confirm((t.teamConfirmRemove || 'Remove?') + '\n' + m.name)) return;
    const prev = members;
    setMembers(ms => ms.filter(x => x.id !== id));
    try {
      await api.request(`/api/team/members/${id}`, { method: 'DELETE' });
      toast(t.teamRemoved, 'x');
      refreshAudit();
    } catch (e) {
      setMembers(prev);
      reportError(e, t, t.teamRemoved);
    }
  }, [members, t, refreshAudit]);

  const addMember = useCallback(async (d) => {
    try {
      const created = await api.request('/api/team/members', {
        method: 'POST',
        body: {
          name: d.name.trim(),
          email: d.email.trim().toLowerCase(),
          password: d.password,
          role: d.role,
        },
      });
      setMembers(ms => [...ms, ...decorateMembers([created])]);
      toast(t.teamInvited, 'plus');
      refreshAudit();
      return true;
    } catch (e) {
      reportError(e, t, t.teamInvited);
      return false;
    }
  }, [t, refreshAudit]);

  const togglePerm = useCallback(async (index, role) => {
    const row = perms[index];
    if (!row) return;
    const cur = !!row[role];
    const prev = perms;
    setPerms(ps => ps.map((p, idx) => idx === index ? { ...p, [role]: !cur } : p));
    try {
      const fresh = await api.request('/api/team/permissions', {
        method: 'PATCH',
        body: { capability: row.key, role, allowed: !cur },
      });
      setPerms(fresh);
      toast(t.teamPermSaved, 'check');
      refreshAudit();
    } catch (e) {
      setPerms(prev);
      reportError(e, t, t.teamPermSaved);
    }
  }, [perms, t, refreshAudit]);

  const resetPerms = useCallback(async () => {
    try {
      const fresh = await api.request('/api/team/permissions/reset', { method: 'POST' });
      setPerms(fresh);
      toast(t.teamPermSaved, 'check');
      refreshAudit();
    } catch (e) {
      reportError(e, t, t.teamPermSaved);
    }
  }, [t, refreshAudit]);

  return {
    members, perms, auditLog,
    myRole, canManage,
    changeRole, removeMember, addMember,
    togglePerm, resetPerms,
  };
}
