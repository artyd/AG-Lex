# Frontend

Vite-built React 19 SPA. No TypeScript, no global state library — plain
`useState`/`useEffect`, prop-drilling, and localStorage.

## Entry

```
src/main.jsx → ReactDOM.createRoot → <App />
```

## `src/App.jsx`

Single root component. Holds:

| State              | Purpose                                                      |
|--------------------|--------------------------------------------------------------|
| `route`            | active screen key (persisted in `localStorage.lx_route`)     |
| `lang`             | `'uk'` or `'en'` (persisted)                                 |
| `t` (tweaks)       | accent / font / dark / density / training — `useTweaks`      |
| `user`             | cached session (`lib/auth.js`)                               |
| `query`            | top-bar search query                                         |
| `analysisIncoming` | payload handed to ContractAnalysis (single OR reconcile run) |
| `uploadOpen`, `contractUploadOpen`, `pairUploadOpen` | modal flags        |
| `serverNotifs`     | server notifications loaded from `/api/notifications`        |
| `notifRead`        | locally-tracked read state (legacy localStorage key)         |

### Deprecated routes

`DEPRECATED_ROUTES` silently re-maps stale `localStorage.lx_route` values
from earlier nav refactors. Add to it when removing a route — don't drop a
user on a blank screen.

### Tweaks markers — DO NOT strip

```js
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{ ... }/*EDITMODE-END*/;
```

The tweaks panel persistence reads these markers to overwrite defaults
inline. Strip them and saved themes stop loading.

### Session lifecycle

- On mount: `lxLoadSession()` reads the cached user, then `refreshSession()`
  hits `/api/auth/refresh` to roll the JWT forward (1-year TTL → effectively
  never logs out as long as the app is opened).
- Any `401` from `api.js` calls `lxSessionExpired()` → fires
  `AUTH_LOGOUT_EVENT` → App.jsx's listener clears `user` + open modals +
  routes back to `/auth`. Without that listener the UI would stick on a
  protected screen with every retry returning "Missing bearer token".

### Realtime wiring

- On user change: `realtimeConnect()` opens `/ws?token=<jwt>`.
- Subscribers (`realtimeSubscribe('notification.new', cb)`) live next to
  the state they update.
- On reconnect: re-fetch notifications to close any gap.

## `src/lib/`

- **`api.js`** — fetch helper. Every backend route gets a typed wrapper
  under `api.<group>`:
  ```js
  api.matters.list()           api.matters.addMember(caseId, body)
  api.codex.sources()          api.codex.articles({source, q, limit, offset})
  api.chat.sessions.list()     api.chat.send({question, sessionId})
  api.notifications.markAllRead()
  ```
  `entity('<slug>')` builds the generic CRUD shape for any of the 15
  workspace entities (`list / get / create / update / remove`).
- **`auth.js`** — `apiLogin`, `apiRegister`, `refreshSession`,
  `getToken`, `authHeaders`, `lxSessionExpired`. Cached under
  `localStorage.aglex_session_v2`.
- **`realtime.js`** — WS client + pub/sub. Events: `notification.new`,
  `case.updated`, `member.added`, `member.removed`, etc.
- **`findingHighlight.js`** — DOM-side mapping from `findings[].suggest.from`
  to `<mark>` overlays. Has its own tests next to it.
- **`reconcileAdapter.js`** — UI-side transform of the `/api/reconcile`
  payload.

## Screens

Files over ~500 lines are mostly screens with embedded sub-components.

| File                                  | Role                                              |
|---------------------------------------|---------------------------------------------------|
| `screens/Auth.jsx`                    | sign up / sign in / language + theme toggle      |
| `screens/Views.jsx` (Dashboard, Library) | landing + matter library cards                 |
| `screens/ContractAnalysis.jsx` (1471L)| single contract analyze AND reconcile result (branches on `incoming.reconcileRun`) |
| `screens/Practice.jsx` (1366L)        | matters list/detail, team picker, kanban tasks    |
| `screens/DocBuilder.jsx` (961L)       | typed-form document generator                     |
| `screens/Litigation.jsx`              | litigation matter view                            |
| `screens/Knowledge.jsx`               | clause library, team, batch                       |
| `screens/Copilot.jsx`                 | AI copilot panel                                  |
| `screens/legislation/LegislationLibrary.jsx` | sources rail → article list → reader      |
| `screens/chat/ChatPage.jsx`           | persistent AI-lawyer session history             |
| `screens/permissions/AccessControl.jsx` | RBAC matrix UI + audit log tail                 |

## UI primitives — `src/ui/`

- `components.jsx` — `Badge`, `Sidebar`, `TopBar`, `Modal`, `Toaster`,
  `toast`, `ScoreRing`, `SectionTitle`.
- `Icon.jsx` — exhaustive SVG icon set. **Add icons here, not inline.** The
  Claude contract-analysis JSON schema enumerates allowed icon names from
  this dict — adding a new keyData icon means updating both sides.
- `HelpTip.jsx` — training-mode tooltip. Rewrote in PR #36 to use
  cursor-following placement after the `display: contents` bug (see
  `docs/BUGS.md`). Don't regress — `display: contents` wraps have ~0
  bounding rects.
- `tweaks-panel.jsx` — theme/font/accent picker; persists to localStorage.

## Styling

CSS variables (`--accent`, `--font-ui`, `--density`) set on the document
element by `App.jsx`. Three files only — no CSS-in-JS, no Tailwind:

- `src/styles/styles.css` (~35k) — global layout primitives, auth screen
- `src/styles/screens.css` (~115k) — all screens, the kitchen sink
- `src/styles/analysis.css` (~45k) — contract-analysis specific

Per-feature CSS: `screens/analysis/markdownDoc.css`,
`screens/chat/chat.css`, `screens/legislation/legislation.css`,
`screens/permissions/permissions.css`.

## i18n

`src/data/i18n.js` exports `I18N = { uk: {...}, en: {...} }`. Looked up
as `t.<key>`. Pass `t` down — there is no context provider.

## Development quirks

- `vite.config.js` proxies `/api` → `http://127.0.0.1:8001` and `/ws` →
  `ws://127.0.0.1:8001`. Override port via `AGLEX_BACKEND_PORT`.
- `vitest` excludes the `e2e/` folder (Playwright specs would fail under
  jsdom).
- Auto-doc generation runs over `src/` too — `scripts/generate_docs.py`
  parses every exported function and writes a module-mirror under `docs/src/`.
