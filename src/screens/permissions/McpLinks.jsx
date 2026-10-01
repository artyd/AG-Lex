/* ============================================================
   McpLinks — «Посилання для Claude без входу» (secret-link MCP
   connectors, /mcp/k/<key>). Part of the Access page MCP section.

   - Create: label + access level + account password (re-checked by the
     backend). The URL is shown once — paste it into Claude Desktop →
     Connectors → Add custom connector.
   - List own links (hint only, never the key) + two-step revoke.
   - `manage`: every link in the firm, revocable.
   ============================================================ */
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { api, ApiError } from '../../lib/api';
import { toast } from '../../ui/components';

const asList = (v) => (Array.isArray(v) ? v : []);

function fmtDate(unix) {
  if (!unix) return '—';
  const d = new Date(unix * 1000);
  const p = x => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function LinksTable({ t, rows, showUser, onRevoke }) {
  const [armed, setArmed] = useState(0);
  if (!rows.length) {
    return <div className="mcp-empty">{t.mcpLinksNone || 'Посилань немає.'}</div>;
  }
  return (
    <table className="acc-table mcp-table">
      <thead>
        <tr>
          <th className="acc-col-cap">{t.mcpLinkLabel || 'Назва'}</th>
          {showUser ? <th>{t.mcpUser || 'Співробітник'}</th> : null}
          <th>{t.mcpAccess || 'Доступ'}</th>
          <th>{t.mcpLinkUsed || 'Використано'}</th>
          <th>{t.mcpLinkExpires || 'Діє до'}</th>
          <th aria-label={t.mcpRevoke || 'Відкликати'} />
        </tr>
      </thead>
      <tbody>
        {rows.map((l) => {
          const isArmed = armed === l.id;
          return (
            <tr key={l.id}>
              <td className="mcp-app-cell">
                <span className="mcp-app-name">{l.label}</span>
                <span className="mcp-app-host">…{l.key_hint}</span>
              </td>
              {showUser ? <td>{l.user_name || l.user_email}</td> : null}
              <td>
                {l.unrestricted ? (
                  <span className="mcp-badge mcp-badge-unrestricted">{t.mcpLinkUnrestrictedBadge || 'Без обмежень'}</span>
                ) : (
                  <span className={'mcp-badge' + (l.profile === 'restricted' ? ' mcp-badge-restricted' : '')}>
                    {l.profile === 'restricted' ? (t.mcpRestricted || 'Обмежений') : (t.mcpFull || 'Повний')}
                  </span>
                )}
              </td>
              <td className="mcp-ts">{fmtDate(l.last_used_at)}</td>
              <td className="mcp-ts">{fmtDate(l.expires_at)}</td>
              <td className="mcp-actions">
                <button
                  type="button"
                  className={'mcp-revoke' + (isArmed ? ' mcp-revoke-armed' : '')}
                  onClick={() => { if (isArmed) { setArmed(0); onRevoke(l); } else { setArmed(l.id); } }}
                  onBlur={() => { if (isArmed) setArmed(0); }}
                >
                  <Icon name="x" size={12} /> {isArmed ? (t.mcpRevokeConfirm || 'Точно відключити?') : (t.mcpLinkRevoke || 'Відкликати')}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function McpLinks({ t, canManage }) {
  const [mine, setMine] = useState([]);
  const [all, setAll] = useState([]);
  const [form, setForm] = useState({ label: 'Claude Desktop', profile: 'full', password: '', unrestricted: false });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  const load = useCallback(async () => {
    try { setMine(asList(await api.request('/api/me/mcp-links'))); } catch (_e) { /* offline */ }
    if (!canManage) return;
    try { setAll(asList(await api.request('/api/admin/mcp-links'))); } catch (_e) { /* 403 tolerated */ }
  }, [canManage]);

  useEffect(() => { load(); }, [load]);

  const create = useCallback(async (e) => {
    e.preventDefault();
    if (busy || (!form.password && !form.unrestricted)) return;
    setBusy(true);
    try {
      const res = await api.request('/api/me/mcp-links', { method: 'POST', body: form });
      setCreated(res);
      setForm(f => ({ ...f, password: '' }));
      load();
    } catch (err) {
      toast((err instanceof ApiError && err.message) || (t.mcpLinkFail || 'Не вдалося створити посилання'), 'alert');
    } finally {
      setBusy(false);
    }
  }, [busy, form, load, t]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(created.url);
      toast(t.mcpLinkCopied || 'Скопійовано', 'check');
    } catch (_e) { /* clipboard blocked: user can select the text */ }
  }, [created, t]);

  const revoke = useCallback(async (l, admin) => {
    try {
      await api.request(`${admin ? '/api/admin' : '/api/me'}/mcp-links/${encodeURIComponent(l.id)}`, { method: 'DELETE' });
      toast(t.mcpLinkRevoked || 'Посилання відкликано', 'check');
      load();
    } catch (err) {
      toast((err instanceof ApiError && err.message) || (t.mcpRevokeFail || 'Не вдалося відключити'), 'alert');
    }
  }, [load, t]);

  return (
    <>
      <h3 className="mcp-sub">{t.mcpLinksTitle || 'Посилання для Claude без входу'}</h3>
      <p className="mcp-hint">
        {t.mcpLinksHint || 'Створіть посилання та вставте його в Claude Desktop → Settings → Connectors → Add custom connector. Логін не потрібен: посилання працює від вашого імені з вашими правами, тож не пересилайте його нікому.'}
      </p>

      <form className="acc-card mcp-link-form" onSubmit={create}>
        <label>
          <span>{t.mcpLinkLabel || 'Назва'}</span>
          <input value={form.label} maxLength={60} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
        </label>
        {!form.unrestricted ? (
          <>
            <label>
              <span>{t.mcpAccess || 'Доступ'}</span>
              <select value={form.profile} onChange={e => setForm(f => ({ ...f, profile: e.target.value }))}>
                <option value="full">{t.mcpLinkFull || 'Повний (Claude)'}</option>
                <option value="restricted">{t.mcpLinkRestricted || 'Обмежений (ChatGPT: без документів і білінгу)'}</option>
              </select>
            </label>
            <label>
              <span>{t.mcpLinkPassword || 'Ваш пароль AG Lex'}</span>
              <input type="password" autoComplete="current-password" value={form.password}
                     onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
            </label>
          </>
        ) : null}
        {canManage ? (
          <label className="mcp-link-unrestricted">
            <span>{t.mcpLinkUnrestricted || 'Без обмежень'}</span>
            <input type="checkbox" checked={form.unrestricted}
                   onChange={e => setForm(f => ({ ...f, unrestricted: e.target.checked }))} />
          </label>
        ) : null}
        <button type="submit" className="acc-reset" disabled={busy || (!form.password && !form.unrestricted)}>
          <Icon name="plus" size={14} /> {t.mcpLinkCreate || 'Створити посилання'}
        </button>
      </form>
      {form.unrestricted ? (
        <p className="mcp-hint mcp-warn">
          {t.mcpLinkUnrestrictedHint || 'Безстрокове посилання без лімітів: бачить усі справи фірми, ігнорує права ролі та конфіденційність для AI. Будь-хто з посиланням має такий доступ — зберігайте його як пароль адміністратора.'}
        </p>
      ) : null}

      {created ? (
        <div className="acc-card mcp-link-created">
          <div className="mcp-app-name">{t.mcpLinkReady || 'Посилання готове — скопіюйте зараз, повторно його не показати:'}</div>
          <code className="mcp-link-url">{created.url}</code>
          <div className="mcp-link-actions">
            <button type="button" className="acc-reset" onClick={copy}>
              <Icon name="clipboard" size={14} /> {t.mcpLinkCopy || 'Копіювати'}
            </button>
            <button type="button" className="mcp-revoke" onClick={() => setCreated(null)}>
              {t.mcpLinkDone || 'Готово'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="acc-card">
        <LinksTable t={t} rows={mine} onRevoke={l => revoke(l, false)} />
      </div>

      {canManage ? (
        <>
          <h3 className="mcp-sub">{t.mcpLinksAll || 'Усі посилання фірми'}</h3>
          <div className="acc-card">
            <LinksTable t={t} rows={all} showUser onRevoke={l => revoke(l, true)} />
          </div>
        </>
      ) : null}
    </>
  );
}
