/* ============================================================
   McpConnections — «AI-підключення (MCP)» section of the Access page
   (docs/mcp/DESIGN.md §5, §6).

   - Everyone: own connected AI apps (Claude, ChatGPT, Cursor…) + revoke.
   - `manage`: all staff connections + revoke, and the privilege policy
     (ai_external=deny) per client / per matter — flagged data is never
     handed to external AI through MCP.
   ============================================================ */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../ui/components';

function fmtTs(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const p = x => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function hostOf(uris) {
  try { return uris && uris[0] ? new URL(uris[0]).host : ''; } catch (_e) { return ''; }
}

// api.request returns null for non-JSON / 204 bodies — never let that reach .map().
const asList = (v) => (Array.isArray(v) ? v : []);
const asPolicy = (v) => ({
  matters: asList(v && v.matters),
  clients: asList(v && v.clients),
  staleClients: asList(v && v.staleClients),
  documentsDenied: !!(v && v.documentsDenied),
});

function fail(e, fallback) {
  toast((e instanceof ApiError && e.message) || fallback, 'alert');
}

function AppsTable({ t, rows, showUser, onRevoke }) {
  // Two-step revoke: first click arms the row, second click disconnects.
  const [armed, setArmed] = useState('');
  if (!rows.length) {
    return <div className="mcp-empty">{t.mcpNoApps || 'Немає підключених AI-застосунків.'}</div>;
  }
  return (
    <table className="acc-table mcp-table">
      <thead>
        <tr>
          <th className="acc-col-cap">{t.mcpApp || 'Застосунок'}</th>
          {showUser ? <th>{t.mcpUser || 'Співробітник'}</th> : null}
          <th>{t.mcpAccess || 'Доступ'}</th>
          <th>{t.mcpLastUsed || 'Оновлено'}</th>
          <th aria-label={t.mcpRevoke || 'Відключити'} />
        </tr>
      </thead>
      <tbody>
        {rows.map(a => {
          const rowKey = `${a.client_id}:${a.user_id}`;
          const isArmed = armed === rowKey;
          return (
          <tr key={rowKey}>
            <td className="mcp-app-cell">
              <span className="mcp-app-name">{a.client_name}</span>
              <span className="mcp-app-host">{hostOf(a.redirect_uris)}</span>
            </td>
            {showUser ? <td>{a.user_name}</td> : null}
            <td>
              <span className={'mcp-badge' + (a.profile === 'restricted' ? ' mcp-badge-restricted' : '')}>
                {a.profile === 'restricted' ? (t.mcpRestricted || 'Обмежений') : (t.mcpFull || 'Повний')}
              </span>
            </td>
            <td className="mcp-ts">{fmtTs(a.last_issued_at)}</td>
            <td className="mcp-actions">
              <button
                type="button"
                className={'mcp-revoke' + (isArmed ? ' mcp-revoke-armed' : '')}
                onClick={() => {
                  if (isArmed) { setArmed(''); onRevoke(a); } else { setArmed(rowKey); }
                }}
                onBlur={() => { if (isArmed) setArmed(''); }}
              >
                <Icon name="x" size={12} /> {isArmed ? (t.mcpRevokeConfirm || 'Точно відключити?') : (t.mcpRevoke || 'Відключити')}
              </button>
            </td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PolicyToggle({ on, label, onClick, disabled }) {
  return (
    <button
      type="button"
      className={'acc-toggle' + (on ? ' acc-toggle-on mcp-deny' : '')}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={on ? 'true' : 'false'}
    >
      {on ? <Icon name="lock" size={12} /> : null}
    </button>
  );
}

export function McpConnections({ t, canManage }) {
  const [mine, setMine] = useState([]);
  const [all, setAll] = useState([]);
  const [policy, setPolicy] = useState(asPolicy(null));

  const load = useCallback(async () => {
    try { setMine(asList(await api.request('/api/me/connected-apps'))); } catch (_e) { /* offline: keep empty */ }
    if (!canManage) return;
    try { setAll(asList(await api.request('/api/admin/connected-apps'))); } catch (_e) { /* 403 tolerated */ }
    try { setPolicy(asPolicy(await api.request('/api/mcp/policy'))); } catch (_e) { /* 403 tolerated */ }
  }, [canManage]);

  useEffect(() => { load(); }, [load]);

  const revokeMine = useCallback(async (a) => {
    try {
      await api.request(`/api/me/connected-apps/${encodeURIComponent(a.client_id)}`, { method: 'DELETE' });
      toast(t.mcpRevoked || 'Застосунок відключено', 'check');
      load();
    } catch (e) { fail(e, t.mcpRevokeFail || 'Не вдалося відключити'); }
  }, [load, t]);

  const revokeAny = useCallback(async (a) => {
    try {
      await api.request(
        `/api/admin/connected-apps/${encodeURIComponent(a.client_id)}/${encodeURIComponent(a.user_id)}`,
        { method: 'DELETE' },
      );
      toast(t.mcpRevoked || 'Застосунок відключено', 'check');
      load();
    } catch (e) { fail(e, t.mcpRevokeFail || 'Не вдалося відключити'); }
  }, [load, t]);

  const toggle = useCallback(async (kind, key, deny) => {
    try {
      await api.request('/api/mcp/policy', { method: 'PUT', body: { kind, key, deny } });
      setPolicy(asPolicy(await api.request('/api/mcp/policy')));
    } catch (e) { fail(e, t.mcpPolicyFail || 'Не вдалося змінити політику'); }
  }, [t]);

  return (
    <section className="mcp-section">
      <header className="mcp-head">
        <Icon name="sparkle" size={16} />
        <h2 className="mcp-title">{t.mcpTitle || 'AI-підключення (MCP)'}</h2>
        <span className="acc-head-sub">
          {t.mcpSub || 'Claude, ChatGPT, Cursor — доступ до справ через ваш акаунт AG Lex.'}
        </span>
      </header>

      <h3 className="mcp-sub">{t.mcpMine || 'Мої підключення'}</h3>
      <div className="acc-card">
        <AppsTable t={t} rows={mine} onRevoke={revokeMine} />
      </div>

      {canManage ? (
        <>
          <h3 className="mcp-sub">{t.mcpAll || 'Усі підключення фірми'}</h3>
          <div className="acc-card">
            <AppsTable t={t} rows={all} showUser onRevoke={revokeAny} />
          </div>

          <h3 className="mcp-sub">{t.mcpPolicy || 'Конфіденційність для зовнішніх AI'}</h3>
          <p className="mcp-hint">
            {t.mcpPolicyHint || 'Позначені клієнти та справи ніколи не передаються в Claude/ChatGPT через MCP (ai_external=deny).'}
          </p>
          <div className="acc-card mcp-global">
            <div className="mcp-app-cell">
              <span className="mcp-app-name">{t.mcpDocsAll || 'Закрити всі завантажені документи'}</span>
              <span className="mcp-app-host">
                {t.mcpDocsHint || 'Документи ще не прив’язані до клієнтів — цей перемикач закриває їх усі від зовнішніх AI.'}
              </span>
            </div>
            <PolicyToggle
              on={policy.documentsDenied}
              label={t.mcpDocsAll || 'Закрити всі документи'}
              onClick={() => toggle('global', 'documents', !policy.documentsDenied)}
            />
          </div>
          {policy.staleClients.length ? (
            <div className="acc-banner">
              <Icon name="alert" size={16} />
              <span>
                {t.mcpStale || 'Закриті клієнти, яких більше немає в базі (перейменовані?) — позначте нову назву:'}{' '}
                {policy.staleClients.join(', ')}
              </span>
            </div>
          ) : null}
          <div className="acc-card mcp-policy">
            <table className="acc-table">
              <thead>
                <tr>
                  <th className="acc-col-cap">{t.mcpClient || 'Клієнт'}</th>
                  <th className="acc-col-role">{t.mcpDeny || 'Закрито'}</th>
                </tr>
              </thead>
              <tbody>
                {policy.clients.map(c => (
                  <tr key={c.name}>
                    <td className="mcp-app-cell"><span className="mcp-app-name">{c.name}</span></td>
                    <td className="acc-cell">
                      <PolicyToggle on={c.denied} label={c.name} onClick={() => toggle('client', c.name, !c.denied)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="acc-table">
              <thead>
                <tr>
                  <th className="acc-col-cap">{t.mcpMatter || 'Справа'}</th>
                  <th className="acc-col-role">{t.mcpDeny || 'Закрито'}</th>
                </tr>
              </thead>
              <tbody>
                {policy.matters.map(m => (
                  <tr key={m.id}>
                    <td className="mcp-app-cell">
                      <span className="mcp-app-name">{m.code} · {m.title}</span>
                      <span className="mcp-app-host">
                        {m.client}{m.deniedViaClient ? ` — ${t.mcpViaClient || 'закрито через клієнта'}` : ''}
                      </span>
                    </td>
                    <td className="acc-cell">
                      <PolicyToggle
                        on={m.denied || m.deniedViaClient}
                        disabled={m.deniedViaClient && !m.denied}
                        label={m.code}
                        onClick={() => toggle('matter', m.id, !m.denied)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
