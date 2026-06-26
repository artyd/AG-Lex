# Glossary

Domain terms used across the codebase. Mostly Ukrainian legal vocabulary —
keep using these spellings, the codex importer's regex relies on the exact
markers («Стаття» / «Article»).

## Ukrainian codices (source codes in `articles.source`)

| Code     | Full name (UA)                          | Notes                                  |
|----------|-----------------------------------------|----------------------------------------|
| `ЦКУ`    | Цивільний кодекс України                | civil code; default citation in chat   |
| `ГКУ`    | Господарський кодекс України            | commercial code                        |
| `КК`     | Кримінальний кодекс                     | criminal code                          |
| `КУпАП`  | Кодекс України про адміністративні правопорушення | administrative offences      |
| `КЗпП`   | Кодекс законів про працю                | labour code                            |
| `ПКУ`    | Податковий кодекс України               | tax code (not yet imported as of 06-26)|
| `СКУ`    | Сімейний кодекс України                 | family code (not yet imported)         |

## EU regulations

| Code       | Full name              |
|------------|------------------------|
| `EU_GDPR`  | GDPR (2016/679)        |
| `EU_DSA`   | Digital Services Act   |
| `EU_DMA`   | Digital Markets Act    |

Filename → code mapping lives in `legal_app/scripts/import_codex.py`
`SOURCE_BY_STEM`. Add to that dict when seeding a new file.

## RBAC vocabulary

| Term            | Where           | Meaning                                                   |
|-----------------|-----------------|-----------------------------------------------------------|
| `role`          | `users.role`    | One of `partner / senior / lawyer / paralegal / admin`    |
| `capability`    | `permissions`   | One of `view / edit / ai / approve / sign / pdata / billing / manage` |
| `case_members`  | DB table        | row-level access list per matter (TEXT user IDs)          |
| `role_in_case`  | `case_members`  | `lead` (can add/remove members) or `collaborator`         |

UA capability labels for the UI live in `rbac.CAPABILITY_LABELS`.

## Product vocabulary

| Term in code        | Term in UI (UA)        | Notes                                            |
|---------------------|------------------------|--------------------------------------------------|
| matter / case       | справа                 | DB table `matters`; route /api/matters           |
| reconciliation      | звірка / погодження    | contract ↔ handover; DB `reconciliations`         |
| handover            | Лист погодження / Таблиця 3 | procurement form compared against the contract |
| codex library       | Законодавство          | browse `articles` by source                      |
| codex sources       | джерела                | values in `articles.source`                      |
| clause library      | бібліотека формулювань | DB `clause_lib`                                  |
| time entry          | списання часу          | DB `time_entries`                                |
| draft               | чернетка               | DB `drafts`; per-row author/team share ACL        |
| chat session        | чат / діалог           | per-user persistent threads of /api/lawyer-chat   |

## Phase numbers (from commit messages + comments)

The repo grew in numbered phases. Phase markers in docstrings point at the
spec section that introduced a module.

| Phase   | Scope                                                       |
|---------|-------------------------------------------------------------|
| 1.1     | Codex schema + import + embeddings                          |
| 1.2     | FTS5 mirror + hybrid search                                 |
| 1.3     | PDF/DOCX → markdown + section split                         |
| 1.4     | Claude wrapper + prompt caching                             |
| 2.1     | Auth: bcrypt + JWT + register/login/me                      |
| 2.2     | Workspace entities (15 tables) + generic CRUD               |
| 2.3     | RBAC matrix + audit log                                     |
| 2.4     | Matters ACL, child endpoints, WebSocket realtime            |
| 3.1     | Contract analysis (`/api/analyze/contract`) — structured output |
| 3.2     | Lawyer assist (summary, translate) + persisted contracts    |
| 3.3     | Doc builder (`/api/generate-document`)                       |
| 4.x     | Display-PDF pipeline (soffice DOCX/XLSX → PDF)              |
| 5       | AI panel polish (Summary / Data / Missing tabs)             |

## Environment variables (see `.env.example`)

| Var                    | Meaning                                                  |
|------------------------|----------------------------------------------------------|
| `API_KEY`              | Anthropic API key (required outside `AGLEX_MOCK_AI=1`)   |
| `MODEL_NAME`           | Claude model id (default `claude-sonnet-4-6`)            |
| `JWT_SECRET`           | HMAC secret for auth tokens                              |
| `EMBED_MODEL`          | Sentence-Transformer model id                            |
| `SOFFICE_PATH`         | LibreOffice binary; default `soffice` from PATH          |
| `DISPLAY_PDF_TIMEOUT`  | seconds per soffice conversion                           |
| `MAX_DISPLAY_PDF_BYTES`| BLOB ceiling for the rendered display PDF                |
| `AGLEX_MOCK_AI`        | `1` makes every AI call return canned fixtures (e2e)     |
| `AGLEX_BACKEND_PORT`   | dev-only; override port the Vite proxy targets           |
| `DB_PATH`              | SQLite file location (Docker uses the named volume path) |
