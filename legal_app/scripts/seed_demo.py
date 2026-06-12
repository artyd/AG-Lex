"""Phase 2.2 demo seed: load prototype `DEMO.*` and `LX.*` rows into SQLite.

Idempotent — each table uses INSERT OR IGNORE so re-running keeps row counts
flat. Called from the FastAPI lifespan on every boot to keep the workspace
populated (the user can override SEED_DEMO=0 in .env to skip — though that
isn't supported here yet, it's a small env knob worth adding later).

Run standalone for ad-hoc seeding:

    venv\\Scripts\\python.exe scripts\\seed_demo.py
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.crud import (  # noqa: E402
    APPROVAL, CLAUSE_LIB, CLIENTS, COMMENTS, DEADLINES, INVOICES, LAWS,
    MATTERS, OBLIGATIONS, TASKS, TEMPLATES, TIME_ENTRIES, VERSIONS,
    upsert_many,
)
from backend.database import get_connection  # noqa: E402
from backend.models import init_entity_schema  # noqa: E402


# ---------------------------------------------------------------------------
# Seed data — verbatim from src/data/demo.js + src/data/lx.js
# ---------------------------------------------------------------------------

MATTERS_SEED = [
    {"id": "m1", "code": "SEV-2026-04", "title": "Супровід ТОВ «Северин»", "client": "ТОВ «Северин»", "type": "Корпоративне", "status": "active", "lead": "u1", "docs": 6, "openTasks": 3, "hours": 24.5, "color": 290},
    {"id": "m2", "code": "VEK-2026-02", "title": "Постачання — ТД «Вектор»", "client": "ТД «Вектор»", "type": "Договірне", "status": "active", "lead": "u2", "docs": 4, "openTasks": 1, "hours": 11.0, "color": 245},
    {"id": "m3", "code": "SKY-2026-01", "title": "NDA та IP — Sky Labs", "client": "Sky Labs Inc.", "type": "IP / IT", "status": "active", "lead": "u3", "docs": 3, "openTasks": 0, "hours": 7.5, "color": 158},
    {"id": "m4", "code": "ZAR-2026-03", "title": "Спір з підряду — ОСББ «Зарічне»", "client": "ОСББ «Зарічне»", "type": "Судовий спір", "status": "active", "lead": "u2", "docs": 5, "openTasks": 4, "hours": 31.0, "color": 320},
    {"id": "m5", "code": "BIT-2026-01", "title": "Ліцензування ПЗ — Бітфордж", "client": "ТОВ «Бітфордж»", "type": "IP / IT", "status": "closed", "lead": "u4", "docs": 4, "openTasks": 0, "hours": 18.0, "color": 25},
]

TASKS_SEED = [
    {"id": "k0", "title": "Подати відзив у справі ОСББ «Зарічне»", "matter": "ZAR-2026-03", "assignee": "u2", "due": "05.06", "priority": "high", "col": "todo"},
    {"id": "k1", "title": "Підготувати протокол розбіжностей за договором «Северин»", "matter": "SEV-2026-04", "assignee": "u1", "due": "11.06", "priority": "high", "col": "progress"},
    {"id": "k2", "title": "Перевірити контрагента ТД «Вектор» у реєстрах", "matter": "VEK-2026-02", "assignee": "u5", "due": "10.06", "priority": "med", "col": "todo"},
    {"id": "k3", "title": "Відповідь на претензію ОСББ «Зарічне»", "matter": "ZAR-2026-03", "assignee": "u2", "due": "12.06", "priority": "high", "col": "progress"},
    {"id": "k4", "title": "Узгодити NDA зі Sky Labs", "matter": "SKY-2026-01", "assignee": "u3", "due": "15.06", "priority": "low", "col": "review"},
    {"id": "k5", "title": "Розрахунок позовної давності за спором", "matter": "ZAR-2026-03", "assignee": "u4", "due": "13.06", "priority": "med", "col": "todo"},
    {"id": "k6", "title": "Виставити рахунок за квітень", "matter": "SEV-2026-04", "assignee": "u6", "due": "09.06", "priority": "med", "col": "review"},
    {"id": "k7", "title": "Фіналізувати ліцензійний договір Бітфордж", "matter": "BIT-2026-01", "assignee": "u4", "due": "04.06", "priority": "low", "col": "done"},
    {"id": "k8", "title": "Внести правки до договору постачання", "matter": "VEK-2026-02", "assignee": "u2", "due": "08.06", "priority": "med", "col": "done"},
    {"id": "k9", "title": "Зібрати докази для суду", "matter": "ZAR-2026-03", "assignee": "u5", "due": "18.06", "priority": "high", "col": "todo"},
]

CLIENTS_SEED = [
    {"id": "cl1", "name": "ТОВ «Северин»", "sector": "Рітейл", "contracts": 3, "open": 2, "color": 290},
    {"id": "cl2", "name": "ТД «Вектор»", "sector": "Дистрибуція", "contracts": 5, "open": 1, "color": 245},
    {"id": "cl3", "name": "Sky Labs Inc.", "sector": "Технології", "contracts": 2, "open": 0, "color": 158},
    {"id": "cl4", "name": "ФОП Кравець А. М.", "sector": "Нерухомість", "contracts": 1, "open": 1, "color": 70},
    {"id": "cl5", "name": "ТОВ «Бітфордж»", "sector": "Розробка ПЗ", "contracts": 4, "open": 1, "color": 25},
    {"id": "cl6", "name": "ОСББ «Зарічне»", "sector": "ЖКГ", "contracts": 2, "open": 1, "color": 320},
]

TEMPLATES_SEED = [
    {"id": "t1", "name": "Договір про надання послуг", "cat": "Послуги", "uses": 48, "fields": 12},
    {"id": "t2", "name": "Угода про нерозголошення (NDA)", "cat": "Захист", "uses": 63, "fields": 8},
    {"id": "t3", "name": "Договір постачання", "cat": "Торгівля", "uses": 31, "fields": 16},
    {"id": "t4", "name": "Договір оренди приміщення", "cat": "Нерухомість", "uses": 22, "fields": 14},
    {"id": "t5", "name": "Трудовий договір", "cat": "HR", "uses": 57, "fields": 18},
    {"id": "t6", "name": "Ліцензійний договір", "cat": "IP", "uses": 14, "fields": 11},
    {"id": "t7", "name": "Додаткова угода", "cat": "Загальне", "uses": 39, "fields": 6},
    {"id": "t8", "name": "Претензія контрагенту", "cat": "Спори", "uses": 18, "fields": 9},
]

INVOICES_SEED = [
    {"id": "inv1", "num": "№ 0142", "client": "ТОВ «Северин»", "period": "Квітень 2026", "amount": 61250, "status": "paid"},
    {"id": "inv2", "num": "№ 0143", "client": "ТД «Вектор»", "period": "Квітень 2026", "amount": 22000, "status": "sent"},
    {"id": "inv3", "num": "№ 0144", "client": "ОСББ «Зарічне»", "period": "Травень 2026", "amount": 48000, "status": "draft"},
]

TIME_ENTRIES_SEED = [
    {"id": "te1", "date": "09.06", "matter": "SEV-2026-04", "who": "u1", "desc": "Аналіз договору та підготовка зауважень", "hours": 2.5, "rate": 2500, "billable": 1},
    {"id": "te2", "date": "09.06", "matter": "ZAR-2026-03", "who": "u2", "desc": "Підготовка відзиву на претензію", "hours": 3.0, "rate": 2000, "billable": 1},
    {"id": "te3", "date": "08.06", "matter": "VEK-2026-02", "who": "u2", "desc": "Узгодження правок із контрагентом", "hours": 1.5, "rate": 2000, "billable": 1},
    {"id": "te4", "date": "08.06", "matter": "SKY-2026-01", "who": "u3", "desc": "Перевірка NDA", "hours": 1.0, "rate": 1800, "billable": 1},
    {"id": "te5", "date": "07.06", "matter": "SEV-2026-04", "who": "u5", "desc": "Збір документів, внутрішня нарада", "hours": 2.0, "rate": 900, "billable": 0},
    {"id": "te6", "date": "07.06", "matter": "ZAR-2026-03", "who": "u4", "desc": "Розрахунок позовної давності", "hours": 1.5, "rate": 1800, "billable": 1},
]

# clause_lib in lx.js is nested under categories — flatten to one row per item.
_CLAUSES_RAW = [
    ("Відповідальність", "cl-1", "Обмеження відповідальності (збалансоване)", "Відповідальність Сторони обмежується розміром реальних збитків, але не більше загальної вартості Договору. Сторони не відповідають за упущену вигоду.", ["ЦК ст. 22, 906"]),
    ("Відповідальність", "cl-2", "Неустойка (двостороння)", "За порушення строків кожна Сторона сплачує іншій пеню в розмірі 0,1% від простроченої суми/вартості етапу за кожен день, але не більше 10%.", ["ЦК ст. 549"]),
    ("Оплата", "cl-3", "Поетапна оплата 30/70", "Оплата здійснюється поетапно: 30% — аванс протягом 5 робочих днів, 70% — протягом 10 робочих днів після підписання акта приймання відповідного етапу.", ["ЦК ст. 903"]),
    ("Оплата", "cl-4", "Повернення авансу", "У разі розірвання Договору з вини Виконавця сплачений аванс підлягає поверненню протягом 10 робочих днів.", ["ЦК ст. 1212"]),
    ("Конфіденційність та дані", "cl-5", "NDA зі строком і санкцією", "Обов'язки конфіденційності діють протягом строку Договору та 3 років після його припинення. За розголошення винна Сторона сплачує штраф у розмірі 100 000 грн.", ["ЦК ст. 505–508"]),
    ("Конфіденційність та дані", "cl-6", "Обробка персональних даних (152 / GDPR)", "Сторони обробляють персональні дані виключно для виконання Договору відповідно до ЗУ «Про захист персональних даних» і вимог GDPR, забезпечуючи їх належний захист.", ["ЗУ про ПД", "GDPR"]),
    ("Розірвання", "cl-7", "Одностороння відмова (ст. 907 ЦК)", "Замовник має право відмовитися від Договору в будь-який час, повідомивши Виконавця за 15 календарних днів та оплативши фактично надані послуги.", ["ЦК ст. 907"]),
    ("Спори", "cl-8", "Підсудність і претензійний порядок", "Спори вирішуються шляхом переговорів; у разі недосягнення згоди — у господарському суді за місцезнаходженням відповідача з дотриманням претензійного порядку.", ["ГПК ст. 19"]),
]
CLAUSE_LIB_SEED = [
    {"id": cid, "cat": cat, "title": title, "text": text, "tags": tags}
    for cat, cid, title, text, tags in _CLAUSES_RAW
]

LAWS_SEED = [
    {"id": "l1", "type": "code", "title": "Цивільний кодекс України", "ref": "Стаття 901. Договір про надання послуг", "snippet": "За договором про надання послуг одна сторона (виконавець) зобов'язується за завданням другої сторони (замовника) надати послугу…", "date": "2003", "tag": "ЦК"},
    {"id": "l2", "type": "code", "title": "Цивільний кодекс України", "ref": "Стаття 907. Розірвання договору про надання послуг", "snippet": "Договір про надання послуг може бути розірваний, у тому числі шляхом односторонньої відмови від договору…", "date": "2003", "tag": "ЦК"},
    {"id": "l3", "type": "code", "title": "Господарський кодекс України", "ref": "Стаття 188. Порядок зміни та розірвання договорів", "snippet": "Зміна та розірвання господарських договорів в односторонньому порядку не допускаються, якщо інше не передбачено законом або договором…", "date": "2003", "tag": "ГК"},
    {"id": "l4", "type": "law", "title": "ЗУ «Про захист персональних даних»", "ref": "Стаття 24. Захист персональних даних", "snippet": "Володільці, розпорядники персональних даних зобов'язані забезпечити захист цих даних від незаконної обробки…", "date": "2010", "tag": "ЗУ"},
    {"id": "l5", "type": "case", "title": "Постанова Верховного Суду", "ref": "справа № 910/4567/24 (КГС ВС)", "snippet": "Умова договору, що позбавляє замовника права на односторонню відмову, передбаченого ст. 907 ЦК України, є нікчемною…", "date": "2024", "tag": "ВС"},
    {"id": "l6", "type": "case", "title": "Постанова Верховного Суду", "ref": "справа № 922/1180/23 (КГС ВС)", "snippet": "Невизначеність істотних умов договору (предмета) може мати наслідком визнання договору неукладеним…", "date": "2023", "tag": "ВС"},
    {"id": "l7", "type": "eu", "title": "Regulation (EU) 2016/679 (GDPR)", "ref": "Art. 28. Processor", "snippet": "Processing by a processor shall be governed by a contract that is binding on the processor with regard to the controller…", "date": "2016", "tag": "EU"},
    {"id": "l8", "type": "eu", "title": "Директива 2011/83/ЄС", "ref": "Про права споживачів", "snippet": "Встановлює правила щодо інформації, права на відмову та інших прав споживачів у договорах…", "date": "2011", "tag": "EU"},
]

COMMENTS_SEED = [
    {"id": "cm1", "clause": "2.3", "author": "u1", "ts": "14.04 10:12", "text": "@Богдан Кравчук тут критична передоплата — наполягаймо на поетапній оплаті.", "mentions": ["Богдан Кравчук"], "resolved": 0},
    {"id": "cm2", "clause": "5.2", "author": "u2", "ts": "14.04 11:03", "text": "Ліміт 50 тис. неприйнятний. Підготував альтернативне формулювання.", "mentions": [], "resolved": 0},
    {"id": "cm3", "clause": "7.3", "author": "u3", "ts": "14.04 12:20", "text": "Суперечить ст. 907 ЦК — додала посилання на практику ВС.", "mentions": [], "resolved": 1},
]

APPROVAL_SEED = [
    {"id": "ap1", "role": "Підготовка", "user": "u3", "status": "done", "date": "08.04.2026", "ord": 1},
    {"id": "ap2", "role": "Юридична перевірка", "user": "u2", "status": "done", "date": "14.04.2026", "ord": 2},
    {"id": "ap3", "role": "Погодження (керівник)", "user": "u1", "status": "current", "date": "—", "ord": 3},
    {"id": "ap4", "role": "Електронний підпис", "user": "u1", "status": "pending", "date": "—", "ord": 4},
]

DEADLINES_SEED = [
    {"id": "d1", "date": "2026-04-23", "title": "Сплатити передоплату (3 робочі дні)", "basis": "п. 2.3", "risk": "high"},
    {"id": "d2", "date": "2027-02-19", "title": "Відмова від автопролонгації (за 60 днів)", "basis": "п. 7.2", "risk": "med"},
    {"id": "d3", "date": "2027-04-20", "title": "Закінчення строку дії Договору", "basis": "п. 3.1", "risk": "med"},
]

OBLIGATIONS_SEED = [
    {"id": "o1", "title": "Оплата за етапами після приймання", "party": "zam", "freq": "monthly", "basis": "п. 2.2", "nextDate": "2026-06-30", "risk": "med"},
    {"id": "o2", "title": "Підписання актів приймання-передавання", "party": "zam", "freq": "monthly", "basis": "п. 3.2", "nextDate": "2026-06-25", "risk": "low"},
    {"id": "o3", "title": "Звіт Виконавця про надані послуги", "party": "vyk", "freq": "quarterly", "basis": "п. 4.2", "nextDate": "2026-07-20", "risk": "low"},
    {"id": "o4", "title": "Дотримання конфіденційності інформації", "party": "both", "freq": "ongoing", "basis": "п. 6", "risk": "med"},
    {"id": "o5", "title": "Повідомити про відмову від автопролонгації", "party": "zam", "freq": "oneoff", "basis": "п. 7.2", "nextDate": "2027-02-19", "risk": "high"},
]

VERSIONS_SEED = [
    {"id": "v1", "label": "Редакція контрагента", "author": "u3", "date": "08.04.2026", "changes": 0, "note": "Початкова версія, надіслана Виконавцем", "current": 0, "draft": 0},
    {"id": "v2", "label": "Наша редакція", "author": "u1", "date": "14.04.2026", "changes": 7, "note": "Правки за результатами ШІ-аналізу", "current": 1, "draft": 0},
    {"id": "v3", "label": "Після переговорів", "author": "u2", "date": "—", "changes": 0, "note": "Очікує на узгодження", "current": 0, "draft": 1},
]

# Phase 2.4: every prototype matter has a lead and 1-2 collaborators. Without
# explicit members, even the legacy `test@aglex.ua` account would see nothing
# in /api/matters after the access-control switch — so we wire the test user
# (legacy_id u1) into every active matter as either lead or collaborator.
CASE_MEMBERS_SEED = [
    # m1 — lead u1, collaborator u2
    {"case_id": "m1", "user_id": "u1", "role_in_case": "lead"},
    {"case_id": "m1", "user_id": "u2", "role_in_case": "collaborator"},
    # m2 — lead u2, collaborator u1 (so the test user sees it too)
    {"case_id": "m2", "user_id": "u2", "role_in_case": "lead"},
    {"case_id": "m2", "user_id": "u1", "role_in_case": "collaborator"},
    # m3 — lead u3, collaborator u1
    {"case_id": "m3", "user_id": "u3", "role_in_case": "lead"},
    {"case_id": "m3", "user_id": "u1", "role_in_case": "collaborator"},
    # m4 — lead u2, collaborators u4, u5
    {"case_id": "m4", "user_id": "u2", "role_in_case": "lead"},
    {"case_id": "m4", "user_id": "u4", "role_in_case": "collaborator"},
    {"case_id": "m4", "user_id": "u5", "role_in_case": "collaborator"},
    # m5 — closed, lead u4
    {"case_id": "m5", "user_id": "u4", "role_in_case": "lead"},
]


_SEEDS: tuple[tuple, ...] = (
    (MATTERS, MATTERS_SEED),
    (TASKS, TASKS_SEED),
    (CLIENTS, CLIENTS_SEED),
    (TEMPLATES, TEMPLATES_SEED),
    (INVOICES, INVOICES_SEED),
    (TIME_ENTRIES, TIME_ENTRIES_SEED),
    (CLAUSE_LIB, CLAUSE_LIB_SEED),
    (LAWS, LAWS_SEED),
    (COMMENTS, COMMENTS_SEED),
    (APPROVAL, APPROVAL_SEED),
    (DEADLINES, DEADLINES_SEED),
    (OBLIGATIONS, OBLIGATIONS_SEED),
    (VERSIONS, VERSIONS_SEED),
)


def seed_legacy_user_ids(conn) -> None:
    """Phase 2.4: bind the test account to prototype id `u1`.

    The test user (`test@aglex.ua`, seeded in auth.seed_test_user) is the
    only account that exists out-of-the-box. We map it to `u1` so the demo
    data — which references `u1` as the lead on m1 — is immediately
    accessible after login. Other accounts get `u{id}` auto-fabricated by
    `cases_acl.resolve_user_text_id` when they first hit a case endpoint.

    Idempotent: only sets legacy_id if NULL.
    """
    conn.execute(
        "UPDATE users SET legacy_id = 'u1' "
        "WHERE email = 'test@aglex.ua' AND legacy_id IS NULL"
    )
    conn.commit()


def seed_case_members(conn) -> None:
    """Populate case_members from CASE_MEMBERS_SEED. Idempotent."""
    import datetime
    ts = datetime.datetime.now(tz=datetime.timezone.utc).isoformat()
    for row in CASE_MEMBERS_SEED:
        conn.execute(
            "INSERT OR IGNORE INTO case_members "
            "(case_id, user_id, role_in_case, added_at, added_by) "
            "VALUES (?, ?, ?, ?, ?)",
            (row["case_id"], row["user_id"], row["role_in_case"], ts, "u1"),
        )
    conn.commit()


def seed_demo_notification(conn) -> None:
    """Insert one demo notification so the bell shows a count on first login.

    Only adds a row if the test user has zero existing notifications, so
    re-runs after the user has interacted with the bell don't re-spam.
    """
    import datetime, uuid
    row = conn.execute(
        "SELECT 1 FROM notifications WHERE user_id = 'u1' LIMIT 1"
    ).fetchone()
    if row:
        return
    ts = datetime.datetime.now(tz=datetime.timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO notifications "
        "(id, user_id, case_id, type, message, payload, is_read, created_at) "
        "VALUES (?, 'u1', 'm4', 'case.updated', ?, ?, 0, ?)",
        (
            uuid.uuid4().hex,
            "Оновлено справу «Спір з підряду — ОСББ Зарічне»",
            '{"field":"status","new_value":"court"}',
            ts,
        ),
    )
    conn.commit()


def seed_all(conn) -> dict[str, int]:
    """Seed every Phase 2.2/2.4 table. Returns {table: rows_targeted}."""
    targeted: dict[str, int] = {}
    for entity, rows in _SEEDS:
        upsert_many(conn, entity, rows)
        targeted[entity.table] = len(rows)
    # Phase 2.4 seeds. Order matters: legacy ids first so case_members rows
    # actually map to a real user; notifications last because they reference
    # an existing matter id.
    seed_legacy_user_ids(conn)
    seed_case_members(conn)
    targeted["case_members"] = len(CASE_MEMBERS_SEED)
    seed_demo_notification(conn)
    return targeted


def main():
    conn = get_connection()
    try:
        init_entity_schema(conn)
        targeted = seed_all(conn)
        for table, n in targeted.items():
            actual = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            print(f"[seed_demo] {table}: seed_set={n}, total={actual}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
