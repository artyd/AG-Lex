/* ============================================================
   AccessControl — «Доступ» tab. Renders the RBAC capability ×
   role matrix that previously lived as the third tab inside the
   Team screen. Reuses /api/team/permissions through useTeamApi
   so any change here is reflected on the Team page (and vice
   versa) without a refresh.
   ============================================================ */
import { Icon } from '../../ui/Icon';
import { roleLabel } from '../../lib/labels';
import { useTeamApi } from './useTeamApi';
import './permissions.css';

const ROLES = ['partner', 'senior', 'lawyer', 'paralegal', 'admin'];

export function AccessControl({ t, user }) {
  const { perms, canManage, togglePerm, resetPerms } = useTeamApi(t, user);

  return (
    <div className="page acc-page">
      <header className="acc-head">
        <div className="acc-head-title">
          <Icon name="key" size={18} />
          <h1 className="acc-title">{t.accessTitle || 'Доступ і права'}</h1>
          <span className="acc-head-sub">
            {t.accessSub || 'Матриця можливостей по ролях. Зміни застосовуються миттєво.'}
          </span>
        </div>
        {canManage ? (
          <button className="acc-reset" onClick={resetPerms} type="button">
            <Icon name="refresh" size={14} /> {t.teamResetPerms || 'Скинути за замовчуванням'}
          </button>
        ) : null}
      </header>

      {!canManage ? (
        <div className="acc-banner">
          <Icon name="alert" size={16} />
          <span>{t.teamNoManage || 'Доступно лише адміністраторам.'}</span>
        </div>
      ) : null}

      <div className="acc-card">
        <table className="acc-table">
          <thead>
            <tr>
              <th className="acc-col-cap">{t.capability || 'Можливість'}</th>
              {ROLES.map(r => (
                <th key={r} className="acc-col-role">{roleLabel(t, r)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {perms.map((p, i) => (
              <tr key={p.key || i}>
                <td className="acc-cap-cell">
                  <span className="acc-cap-key">{p.key}</span>
                  <span className="acc-cap-label">{p.cap}</span>
                </td>
                {ROLES.map(r => (
                  <td key={r} className="acc-cell">
                    {canManage ? (
                      <button
                        type="button"
                        className={'acc-toggle' + (p[r] ? ' acc-toggle-on' : '')}
                        onClick={() => togglePerm(i, r)}
                        aria-label={`${p.cap} · ${roleLabel(t, r)}`}
                        aria-pressed={p[r] ? 'true' : 'false'}
                      >
                        {p[r] ? <Icon name="check" size={12} stroke={3} /> : null}
                      </button>
                    ) : (
                      p[r]
                        ? <span className="acc-yes" aria-label={t.actPermOn || 'On'}><Icon name="check" size={12} stroke={3} /></span>
                        : <span className="acc-no" aria-hidden="true">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
