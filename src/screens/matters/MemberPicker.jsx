/* ============================================================
   MemberPicker — add a teammate to a case.
   Lists every user from /api/team/members, lets the lead pick one
   (with a role-in-case), POSTs to /api/matters/{id}/members.
   The backend broadcasts member.added + notification.new, so the
   target user sees it within ~1s without reload.
   ============================================================ */
import { useEffect, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { Modal, toast } from '../../ui/components';
import { api } from '../../lib/api';
import { UserAvatar } from '../../lib/labels';

export function MemberPicker({ open, onClose, caseId, currentMemberIds = [], onAdded, t }) {
  const [users, setUsers] = useState([]);
  const [role, setRole] = useState('collaborator');
  const [pendingId, setPendingId] = useState(null);

  useEffect(() => {
    if (!open) return;
    api.team.members()
      .then(rows => setUsers(Array.isArray(rows) ? rows : []))
      .catch(() => setUsers([]));
    setRole('collaborator');
    setPendingId(null);
  }, [open]);

  const taken = new Set(currentMemberIds);

  const add = async (user) => {
    if (!user.legacy_id) {
      toast(t.mt_team_no_legacy || 'Не вдалося визначити ідентифікатор', 'alert');
      return;
    }
    setPendingId(user.id);
    try {
      await api.matters.addMember(caseId, {
        user_id: user.legacy_id,
        role_in_case: role,
      });
      toast(t.mt_team_added || 'Учасника додано', 'plus');
      onAdded && onAdded(user.legacy_id);
      onClose();
    } catch (e) {
      toast(e.message || 'Помилка', 'alert');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t.mt_team_pick || 'Оберіть учасника'} sub={t.mt_team_add_sub || 'Додасться до команди справи й отримає сповіщення'} icon="clients">
      <div className="field-row" style={{ marginBottom: 'var(--s4)' }}>
        <label className="field-label">{t.mt_team_role || 'Роль у справі'}</label>
        <div className="seg">
          {['collaborator', 'lead'].map(r => (
            <button key={r} type="button" className={role === r ? 'on' : ''} onClick={() => setRole(r)}>
              {r === 'lead' ? (t.mt_team_role_lead || 'Веде справу') : (t.mt_team_role_collab || 'Учасник')}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-member-list">
        {users.length === 0 ? (
          <div className="mt-empty"><Icon name="clients" size={26} /><div>—</div></div>
        ) : users.map(u => {
          const already = u.legacy_id && taken.has(u.legacy_id);
          return (
            <button
              key={u.id}
              className={'mt-member-row' + (already ? ' mt-member-row-disabled' : '')}
              onClick={() => !already && add(u)}
              disabled={already || pendingId === u.id}
            >
              <UserAvatar id={u.legacy_id || ('u' + u.id)} size={32} />
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{u.name}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{u.email}</div>
              </div>
              {already ? (
                <span className="chip" style={{ fontSize: 11 }}>{t.mt_team_already || 'Вже в команді'}</span>
              ) : (
                <Icon name="plus" size={15} style={{ color: 'var(--accent)' }} />
              )}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
