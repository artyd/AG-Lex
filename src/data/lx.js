/* ============================================================
   Lexena — extended workspace data (window.LX)
   Matters, tasks, team/roles, billing, clause library,
   legislation search, counterparties, audit, versions,
   comments, approval route.  All names invented.
   ============================================================ */
export const LX = (function () {

  /* ---------- Team & roles ---------- */
  const team = [
    { id: 'u1', name: 'Марина Орлова', initials: 'МО', role: 'partner', email: 'm.orlova@aglex.ua', color: 290, status: 'online' },
    { id: 'u2', name: 'Богдан Кравчук', initials: 'БК', role: 'senior', email: 'b.kravchuk@aglex.ua', color: 245, status: 'online' },
    { id: 'u3', name: 'Олена Гриценко', initials: 'ОГ', role: 'lawyer', email: 'o.grytsenko@aglex.ua', color: 158, status: 'away' },
    { id: 'u4', name: 'Тарас Мельник', initials: 'ТМ', role: 'lawyer', email: 't.melnyk@aglex.ua', color: 70, status: 'offline' },
    { id: 'u5', name: 'Ірина Шевченко', initials: 'ІШ', role: 'paralegal', email: 'i.shevchenko@aglex.ua', color: 25, status: 'online' },
    { id: 'u6', name: 'Сергій Дідух', initials: 'СД', role: 'admin', email: 's.didukh@aglex.ua', color: 320, status: 'offline' },
  ];
  // permission matrix: rows = capabilities, cols = roles
  const roleOrder = ['partner', 'senior', 'lawyer', 'paralegal', 'admin'];
  const permissions = [
    { key: 'view',    cap: 'Перегляд договорів',        partner: true,  senior: true,  lawyer: true,  paralegal: true,  admin: true },
    { key: 'edit',    cap: 'Редагування та правки',     partner: true,  senior: true,  lawyer: true,  paralegal: false, admin: false },
    { key: 'ai',      cap: 'Запуск ШІ-аналізу',         partner: true,  senior: true,  lawyer: true,  paralegal: true,  admin: false },
    { key: 'approve', cap: 'Погодження редакції',       partner: true,  senior: true,  lawyer: false, paralegal: false, admin: false },
    { key: 'sign',    cap: 'Електронний підпис',        partner: true,  senior: false, lawyer: false, paralegal: false, admin: false },
    { key: 'pdata',   cap: 'Доступ до персональних даних', partner: true, senior: true, lawyer: true,  paralegal: false, admin: true },
    { key: 'billing', cap: 'Білінг і рахунки',          partner: true,  senior: false, lawyer: false, paralegal: false, admin: true },
    { key: 'manage',  cap: 'Керування командою',        partner: true,  senior: false, lawyer: false, paralegal: false, admin: true },
  ];

  /* ---------- Matters (справи) ---------- */
  const matters = [
    { id: 'm1', code: 'SEV-2026-04', title: 'Супровід ТОВ «Северин»', client: 'ТОВ «Северин»', type: 'Корпоративне', status: 'active', lead: 'u1', docs: 6, openTasks: 3, hours: 24.5, color: 290 },
    { id: 'm2', code: 'VEK-2026-02', title: 'Постачання — ТД «Вектор»', client: 'ТД «Вектор»', type: 'Договірне', status: 'active', lead: 'u2', docs: 4, openTasks: 1, hours: 11.0, color: 245 },
    { id: 'm3', code: 'SKY-2026-01', title: 'NDA та IP — Sky Labs', client: 'Sky Labs Inc.', type: 'IP / IT', status: 'active', lead: 'u3', docs: 3, openTasks: 0, hours: 7.5, color: 158 },
    { id: 'm4', code: 'ZAR-2026-03', title: 'Спір з підряду — ОСББ «Зарічне»', client: 'ОСББ «Зарічне»', type: 'Судовий спір', status: 'active', lead: 'u2', docs: 5, openTasks: 4, hours: 31.0, color: 320 },
    { id: 'm5', code: 'BIT-2026-01', title: 'Ліцензування ПЗ — Бітфордж', client: 'ТОВ «Бітфордж»', type: 'IP / IT', status: 'closed', lead: 'u4', docs: 4, openTasks: 0, hours: 18.0, color: 25 },
  ];

  /* ---------- Tasks (kanban) ---------- */
  const tasks = [
    { id: 'k0', title: 'Подати відзив у справі ОСББ «Зарічне»', matter: 'ZAR-2026-03', assignee: 'u2', due: '05.06', priority: 'high', col: 'todo' },
    { id: 'k1', title: 'Підготувати протокол розбіжностей за договором «Северин»', matter: 'SEV-2026-04', assignee: 'u1', due: '11.06', priority: 'high', col: 'progress' },
    { id: 'k2', title: 'Перевірити контрагента ТД «Вектор» у реєстрах', matter: 'VEK-2026-02', assignee: 'u5', due: '10.06', priority: 'med', col: 'todo' },
    { id: 'k3', title: 'Відповідь на претензію ОСББ «Зарічне»', matter: 'ZAR-2026-03', assignee: 'u2', due: '12.06', priority: 'high', col: 'progress' },
    { id: 'k4', title: 'Узгодити NDA зі Sky Labs', matter: 'SKY-2026-01', assignee: 'u3', due: '15.06', priority: 'low', col: 'review' },
    { id: 'k5', title: 'Розрахунок позовної давності за спором', matter: 'ZAR-2026-03', assignee: 'u4', due: '13.06', priority: 'med', col: 'todo' },
    { id: 'k6', title: 'Виставити рахунок за квітень', matter: 'SEV-2026-04', assignee: 'u6', due: '09.06', priority: 'med', col: 'review' },
    { id: 'k7', title: 'Фіналізувати ліцензійний договір Бітфордж', matter: 'BIT-2026-01', assignee: 'u4', due: '04.06', priority: 'low', col: 'done' },
    { id: 'k8', title: 'Внести правки до договору постачання', matter: 'VEK-2026-02', assignee: 'u2', due: '08.06', priority: 'med', col: 'done' },
    { id: 'k9', title: 'Зібрати докази для суду', matter: 'ZAR-2026-03', assignee: 'u5', due: '18.06', priority: 'high', col: 'todo' },
  ];
  const kanbanCols = [
    { id: 'todo', label: 'До виконання' },
    { id: 'progress', label: 'У роботі' },
    { id: 'review', label: 'На перевірці' },
    { id: 'done', label: 'Готово' },
  ];

  /* ---------- Time & billing ---------- */
  const timeEntries = [
    { id: 'te1', date: '09.06', matter: 'SEV-2026-04', who: 'u1', desc: 'Аналіз договору та підготовка зауважень', hours: 2.5, rate: 2500, billable: true },
    { id: 'te2', date: '09.06', matter: 'ZAR-2026-03', who: 'u2', desc: 'Підготовка відзиву на претензію', hours: 3.0, rate: 2000, billable: true },
    { id: 'te3', date: '08.06', matter: 'VEK-2026-02', who: 'u2', desc: 'Узгодження правок із контрагентом', hours: 1.5, rate: 2000, billable: true },
    { id: 'te4', date: '08.06', matter: 'SKY-2026-01', who: 'u3', desc: 'Перевірка NDA', hours: 1.0, rate: 1800, billable: true },
    { id: 'te5', date: '07.06', matter: 'SEV-2026-04', who: 'u5', desc: 'Збір документів, внутрішня нарада', hours: 2.0, rate: 900, billable: false },
    { id: 'te6', date: '07.06', matter: 'ZAR-2026-03', who: 'u4', desc: 'Розрахунок позовної давності', hours: 1.5, rate: 1800, billable: true },
  ];
  const invoices = [
    { id: 'inv1', num: '№ 0142', client: 'ТОВ «Северин»', period: 'Квітень 2026', amount: 61250, status: 'paid' },
    { id: 'inv2', num: '№ 0143', client: 'ТД «Вектор»', period: 'Квітень 2026', amount: 22000, status: 'sent' },
    { id: 'inv3', num: '№ 0144', client: 'ОСББ «Зарічне»', period: 'Травень 2026', amount: 48000, status: 'draft' },
  ];

  /* ---------- Clause library ---------- */
  const clauseLib = [
    { cat: 'Відповідальність', items: [
      { id: 'cl-1', title: 'Обмеження відповідальності (збалансоване)', text: 'Відповідальність Сторони обмежується розміром реальних збитків, але не більше загальної вартості Договору. Сторони не відповідають за упущену вигоду.', tags: ['ЦК ст. 22, 906'] },
      { id: 'cl-2', title: 'Неустойка (двостороння)', text: 'За порушення строків кожна Сторона сплачує іншій пеню в розмірі 0,1% від простроченої суми/вартості етапу за кожен день, але не більше 10%.', tags: ['ЦК ст. 549'] },
    ]},
    { cat: 'Оплата', items: [
      { id: 'cl-3', title: 'Поетапна оплата 30/70', text: 'Оплата здійснюється поетапно: 30% — аванс протягом 5 робочих днів, 70% — протягом 10 робочих днів після підписання акта приймання відповідного етапу.', tags: ['ЦК ст. 903'] },
      { id: 'cl-4', title: 'Повернення авансу', text: 'У разі розірвання Договору з вини Виконавця сплачений аванс підлягає поверненню протягом 10 робочих днів.', tags: ['ЦК ст. 1212'] },
    ]},
    { cat: 'Конфіденційність та дані', items: [
      { id: 'cl-5', title: 'NDA зі строком і санкцією', text: 'Обов’язки конфіденційності діють протягом строку Договору та 3 років після його припинення. За розголошення винна Сторона сплачує штраф у розмірі 100 000 грн.', tags: ['ЦК ст. 505–508'] },
      { id: 'cl-6', title: 'Обробка персональних даних (152 / GDPR)', text: 'Сторони обробляють персональні дані виключно для виконання Договору відповідно до ЗУ «Про захист персональних даних» і вимог GDPR, забезпечуючи їх належний захист.', tags: ['ЗУ про ПД', 'GDPR'] },
    ]},
    { cat: 'Розірвання', items: [
      { id: 'cl-7', title: 'Одностороння відмова (ст. 907 ЦК)', text: 'Замовник має право відмовитися від Договору в будь-який час, повідомивши Виконавця за 15 календарних днів та оплативши фактично надані послуги.', tags: ['ЦК ст. 907'] },
    ]},
    { cat: 'Спори', items: [
      { id: 'cl-8', title: 'Підсудність і претензійний порядок', text: 'Спори вирішуються шляхом переговорів; у разі недосягнення згоди — у господарському суді за місцезнаходженням відповідача з дотриманням претензійного порядку.', tags: ['ГПК ст. 19'] },
    ]},
  ];

  /* ---------- Legislation & case law search ---------- */
  const laws = [
    { id: 'l1', type: 'code', title: 'Цивільний кодекс України', ref: 'Стаття 901. Договір про надання послуг', snippet: 'За договором про надання послуг одна сторона (виконавець) зобов’язується за завданням другої сторони (замовника) надати послугу…', date: '2003', tag: 'ЦК' },
    { id: 'l2', type: 'code', title: 'Цивільний кодекс України', ref: 'Стаття 907. Розірвання договору про надання послуг', snippet: 'Договір про надання послуг може бути розірваний, у тому числі шляхом односторонньої відмови від договору…', date: '2003', tag: 'ЦК' },
    { id: 'l3', type: 'code', title: 'Господарський кодекс України', ref: 'Стаття 188. Порядок зміни та розірвання договорів', snippet: 'Зміна та розірвання господарських договорів в односторонньому порядку не допускаються, якщо інше не передбачено законом або договором…', date: '2003', tag: 'ГК' },
    { id: 'l4', type: 'law', title: 'ЗУ «Про захист персональних даних»', ref: 'Стаття 24. Захист персональних даних', snippet: 'Володільці, розпорядники персональних даних зобов’язані забезпечити захист цих даних від незаконної обробки…', date: '2010', tag: 'ЗУ' },
    { id: 'l5', type: 'case', title: 'Постанова Верховного Суду', ref: 'справа № 910/4567/24 (КГС ВС)', snippet: 'Умова договору, що позбавляє замовника права на односторонню відмову, передбаченого ст. 907 ЦК України, є нікчемною…', date: '2024', tag: 'ВС' },
    { id: 'l6', type: 'case', title: 'Постанова Верховного Суду', ref: 'справа № 922/1180/23 (КГС ВС)', snippet: 'Невизначеність істотних умов договору (предмета) може мати наслідком визнання договору неукладеним…', date: '2023', tag: 'ВС' },
    { id: 'l7', type: 'eu', title: 'Regulation (EU) 2016/679 (GDPR)', ref: 'Art. 28. Processor', snippet: 'Processing by a processor shall be governed by a contract that is binding on the processor with regard to the controller…', date: '2016', tag: 'EU' },
    { id: 'l8', type: 'eu', title: 'Директива 2011/83/ЄС', ref: 'Про права споживачів', snippet: 'Встановлює правила щодо інформації, права на відмову та інших прав споживачів у договорах…', date: '2011', tag: 'EU' },
  ];

  /* ---------- Counterparty registry (lookup by code) ---------- */
  const counterparties = {
    '41928374': { name: 'ТОВ «Аркада Діджитал»', status: 'active', director: 'Гайда Павло Сергійович', kved: '62.01 Комп’ютерне програмування', registered: '12.03.2019', address: 'м. Київ, вул. Антоновича, 18', capital: '100 000 грн', sanctions: false, courtCases: 2, taxDebt: false, risk: 'med',
      dd: { score: 68, founded: '2019', employees: '24', revenue: '8,4 млн ₴ / рік', vat: true, pep: false, bankruptcy: false, enforcement: 1,
        factors: [['reg', 90], ['sanc', 100], ['lit', 60], ['tax', 85], ['fin', 70]],
        court: { plaintiff: 1, defendant: 1, open: 1, claims: '320 тис. ₴' },
        benef: [{ name: 'Гайда Павло Сергійович', share: '100%' }] } },
    '39281746': { name: 'ТД «Вектор»', status: 'active', director: 'Бондаренко Олег Іванович', kved: '46.69 Оптова торгівля', registered: '05.07.2015', address: 'м. Львів, вул. Городоцька, 270', capital: '500 000 грн', sanctions: false, courtCases: 0, taxDebt: false, risk: 'low',
      dd: { score: 88, founded: '2015', employees: '58', revenue: '42 млн ₴ / рік', vat: true, pep: false, bankruptcy: false, enforcement: 0,
        factors: [['reg', 95], ['sanc', 100], ['lit', 95], ['tax', 90], ['fin', 82]],
        court: { plaintiff: 0, defendant: 0, open: 0, claims: '—' },
        benef: [{ name: 'Бондаренко Олег Іванович', share: '60%' }, { name: 'Іваненко Марія Олегівна', share: '40%' }] } },
    '38561029': { name: 'ТОВ «Грифон Логістик»', status: 'terminated', director: 'Сидоренко Іван Петрович', kved: '49.41 Вантажний транспорт', registered: '22.11.2012', address: 'м. Дніпро, пр. Яворницького, 5', capital: '50 000 грн', sanctions: true, courtCases: 7, taxDebt: true, risk: 'high',
      dd: { score: 24, founded: '2012', employees: 'н/д', revenue: 'спад / збитки', vat: false, pep: true, bankruptcy: true, enforcement: 5,
        factors: [['reg', 30], ['sanc', 10], ['lit', 25], ['tax', 20], ['fin', 35]],
        court: { plaintiff: 1, defendant: 6, open: 4, claims: '2,1 млн ₴' },
        benef: [{ name: 'Сидоренко Іван Петрович', share: '100%' }] } },
  };
  const cpSuggest = [
    { code: '41928374', name: 'ТОВ «Аркада Діджитал»' },
    { code: '39281746', name: 'ТД «Вектор»' },
    { code: '38561029', name: 'ТОВ «Грифон Логістик» (приклад ризику)' },
  ];

  /* ---------- Audit log ---------- */
  const audit = [
    { id: 'a1', ts: '09.06.2026 14:22', who: 'u1', action: 'Застосувала всі правки', target: 'Договір 2026/04-К' },
    { id: 'a2', ts: '09.06.2026 13:58', who: 'u2', action: 'Створив протокол розбіжностей', target: 'Договір 2026/04-К' },
    { id: 'a3', ts: '09.06.2026 11:40', who: 'u3', action: 'Переглянула NDA', target: 'SKY-2026-01' },
    { id: 'a4', ts: '08.06.2026 17:05', who: 'u1', action: 'Підписала редакцію', target: 'BIT-2026-01' },
    { id: 'a5', ts: '08.06.2026 16:12', who: 'u5', action: 'Доступ до персональних даних', target: 'ТОВ «Северин»' },
    { id: 'a6', ts: '08.06.2026 09:30', who: 'u6', action: 'Виставив рахунок № 0143', target: 'ТД «Вектор»' },
    { id: 'a7', ts: '07.06.2026 18:44', who: 'u4', action: 'Запустив ШІ-аналіз', target: 'Договір постачання № 88' },
  ];

  /* ---------- Versions of the current contract ---------- */
  const versions = [
    { id: 'v1', label: 'Редакція контрагента', author: 'u3', date: '08.04.2026', changes: 0, note: 'Початкова версія, надіслана Виконавцем' },
    { id: 'v2', label: 'Наша редакція', author: 'u1', date: '14.04.2026', changes: 7, note: 'Правки за результатами ШІ-аналізу', current: true },
    { id: 'v3', label: 'Після переговорів', author: 'u2', date: '—', changes: 0, note: 'Очікує на узгодження', draft: true },
  ];
  // Redline pairs (старе → нове) for diff view
  const diffPairs = [
    { clause: 'п. 2.3', a: 'Замовник здійснює оплату в розмірі 100% (передоплата) протягом 3 робочих днів. Сплачена передоплата поверненню не підлягає за жодних обставин.',
      b: 'Замовник здійснює оплату поетапно: 30% — аванс, 70% — за фактом приймання етапу. У разі розірвання з вини Виконавця аванс повертається протягом 10 робочих днів.' },
    { clause: 'п. 5.2', a: 'Відповідальність Виконавця обмежується сумою 50 000 гривень незалежно від розміру завданих збитків.',
      b: 'Відповідальність Виконавця обмежується загальною вартістю послуг за Договором і включає відшкодування реальних збитків Замовнику.' },
    { clause: 'п. 7.3', a: 'Замовник має право розірвати Договір в односторонньому порядку лише за згодою Виконавця.',
      b: 'Замовник має право розірвати Договір у будь-який час, повідомивши за 15 днів та оплативши фактично надані послуги (ст. 907 ЦК України).' },
  ];

  /* ---------- Comments / mentions ---------- */
  const comments = [
    { id: 'cm1', clause: '2.3', author: 'u1', ts: '14.04 10:12', text: '@Богдан Кравчук тут критична передоплата — наполягаймо на поетапній оплаті.', mentions: ['Богдан Кравчук'], resolved: false },
    { id: 'cm2', clause: '5.2', author: 'u2', ts: '14.04 11:03', text: 'Ліміт 50 тис. неприйнятний. Підготував альтернативне формулювання.', mentions: [], resolved: false },
    { id: 'cm3', clause: '7.3', author: 'u3', ts: '14.04 12:20', text: 'Суперечить ст. 907 ЦК — додала посилання на практику ВС.', mentions: [], resolved: true },
  ];

  /* ---------- Approval route ---------- */
  const approval = [
    { role: 'Підготовка', user: 'u3', status: 'done', date: '08.04.2026' },
    { role: 'Юридична перевірка', user: 'u2', status: 'done', date: '14.04.2026' },
    { role: 'Погодження (керівник)', user: 'u1', status: 'current', date: '—' },
    { role: 'Електронний підпис', user: 'u1', status: 'pending', date: '—' },
  ];

  // extracted deadlines (auto → calendar)
  const deadlines = [
    { id: 'd1', date: '2026-04-23', title: 'Сплатити передоплату (3 робочі дні)', basis: 'п. 2.3', risk: 'high' },
    { id: 'd2', date: '2027-02-19', title: 'Відмова від автопролонгації (за 60 днів)', basis: 'п. 7.2', risk: 'med' },
    { id: 'd3', date: '2027-04-20', title: 'Закінчення строку дії Договору', basis: 'п. 3.1', risk: 'med' },
  ];

  // extracted recurring/ongoing obligations (ШІ-витяг зобовʼязань)
  const obligations = [
    { id: 'o1', title: 'Оплата за етапами після приймання', party: 'zam', freq: 'monthly', basis: 'п. 2.2', nextDate: '2026-06-30', risk: 'med' },
    { id: 'o2', title: 'Підписання актів приймання-передавання', party: 'zam', freq: 'monthly', basis: 'п. 3.2', nextDate: '2026-06-25', risk: 'low' },
    { id: 'o3', title: 'Звіт Виконавця про надані послуги', party: 'vyk', freq: 'quarterly', basis: 'п. 4.2', nextDate: '2026-07-20', risk: 'low' },
    { id: 'o4', title: 'Дотримання конфіденційності інформації', party: 'both', freq: 'ongoing', basis: 'п. 6', risk: 'med' },
    { id: 'o5', title: 'Повідомити про відмову від автопролонгації', party: 'zam', freq: 'oneoff', basis: 'п. 7.2', nextDate: '2027-02-19', risk: 'high' },
  ];

  const userById = Object.fromEntries(team.map(u => [u.id, u]));

  /* ---------- Litigation (спори) ---------- */
  const litigation = {
    case: { code: 'ZAR-2026-03', title: 'Спір з підряду — ОСББ «Зарічне»', court: 'Господарський суд міста Києва', judge: 'суддя Левченко О. П.', stage: 'Перша інстанція', nextHearing: '2026-06-20', role: 'Відповідач', amount: '2,1 млн ₴', number: '910/4821/26' },
    timeline: [
      { date: '2026-03-05', type: 'claim', title: 'Отримано претензію від ОСББ «Зарічне»' },
      { date: '2026-03-20', type: 'doc', title: 'Надіслано відповідь на претензію' },
      { date: '2026-04-12', type: 'filed', title: 'ОСББ подало позовну заяву до суду' },
      { date: '2026-04-28', type: 'hearing', title: 'Підготовче засідання' },
      { date: '2026-05-15', type: 'doc', title: 'Подано відзив на позовну заяву' },
      { date: '2026-06-20', type: 'hearing', title: 'Засідання по суті справи', upcoming: true },
    ],
    rules: [
      { id: 'vidzyv', label: 'Відзив на позов', days: 15 },
      { id: 'zaper', label: 'Заперечення на відзив', days: 10 },
      { id: 'apel', label: 'Апеляційна скарга', days: 20 },
      { id: 'kasac', label: 'Касаційна скарга', days: 30 },
      { id: 'vykon', label: 'Добровільне виконання рішення', days: 10 },
    ],
    pleadings: [
      { id: 'pl1', name: 'Відзив на позовну заяву', status: 'done' },
      { id: 'pl2', name: 'Клопотання про витребування доказів', status: 'draft' },
      { id: 'pl3', name: 'Апеляційна скарга', status: 'planned' },
    ],
  };

  /* ---------- Document review / e-discovery ---------- */
  const review = [
    { id: 'r1', name: 'Договір підряду № 17', kind: 'Договір', date: '12.02.2026', relevance: 'relevant', privilege: false, responsive: true, reviewed: true, snippet: '…умови виконання робіт, строки та відповідальність підрядника за якість…' },
    { id: 'r2', name: 'Лист-претензія від ОСББ «Зарічне»', kind: 'Лист', date: '05.03.2026', relevance: 'relevant', privilege: false, responsive: true, reviewed: false, snippet: '…вимога усунути недоліки робіт та сплатити неустойку в розмірі…' },
    { id: 'r3', name: 'Внутрішня записка юрвідділу', kind: 'Меморандум', date: '10.03.2026', relevance: 'maybe', privilege: true, responsive: false, reviewed: false, snippet: '…оцінка перспектив спору та стратегія захисту позиції клієнта…' },
    { id: 'r4', name: 'Акти виконаних робіт (5 шт.)', kind: 'Акт', date: '2025–2026', relevance: 'relevant', privilege: false, responsive: true, reviewed: false, snippet: '…підписані акти приймання-передачі виконаних робіт за етапами…' },
    { id: 'r5', name: 'Email-листування з підрядником', kind: 'Листування', date: '2026', relevance: 'maybe', privilege: false, responsive: true, reviewed: false, snippet: '…узгодження строків, обсягів робіт та додаткових витрат…' },
    { id: 'r6', name: 'Кошторис проєкту', kind: 'Кошторис', date: '01.2025', relevance: 'no', privilege: false, responsive: false, reviewed: false, snippet: '…розрахунок вартості матеріалів та робіт за проєктом…' },
    { id: 'r7', name: 'Висновок будівельної експертизи', kind: 'Експертиза', date: '04.2026', relevance: 'relevant', privilege: false, responsive: true, reviewed: false, snippet: '…виявлено відхилення робіт від проєктної документації…' },
    { id: 'r8', name: 'Чернетка мирової угоди', kind: 'Проєкт', date: '05.2026', relevance: 'maybe', privilege: true, responsive: false, reviewed: false, snippet: '…умови врегулювання спору та розподіл витрат сторін…' },
  ];

  /* ---------- E-signature queue ---------- */
  const esignQueue = [
    { id: 'es1', name: 'Договір про надання послуг № 2026/04-К', client: 'ТОВ «Северин»', date: '09.06.2026', status: 'pending' },
    { id: 'es2', name: 'Угода про нерозголошення — Sky Labs', client: 'Sky Labs Inc.', date: '08.06.2026', status: 'pending' },
    { id: 'es3', name: 'Додаткова угода № 1 — ТД «Вектор»', client: 'ТД «Вектор»', date: '07.06.2026', status: 'pending' },
    { id: 'es4', name: 'Ліцензійний договір — Бітфордж', client: 'ТОВ «Бітфордж»', date: '04.06.2026', status: 'signed', hash: 'A3F1·9C2E·77B4·E0D5', signedAt: '04.06.2026 16:05', signer: 'Марина Орлова' },
  ];

  /* ---------- Conflict-of-interest database ---------- */
  const conflictsDB = [
    { match: 'северин', level: 'potential', items: [{ name: 'ТОВ «Северин»', relation: 'Вже ваш клієнт — справа SEV-2026-04 (3 договори). Потрібне розкриття.' }] },
    { match: 'вектор', level: 'potential', items: [{ name: 'ТД «Вектор»', relation: 'Контрагент у справі VEK-2026-02, де ви представляєте іншу сторону.' }] },
    { match: 'зарічне', level: 'block', items: [{ name: 'ОСББ «Зарічне»', relation: 'Ви вже представляєте сторону у спорі ZAR-2026-03 за їх участю.' }] },
    { match: 'грифон', level: 'block', items: [{ name: 'ТОВ «Грифон Логістик»', relation: 'Опонент у двох завершених справах; перебуває під санкціями.' }] },
  ];
  const conflictSuggest = ['ТОВ «Северин»', 'ТД «Вектор»', 'ОСББ «Зарічне»', 'ТОВ «Орбіта Плюс»'];

  /* ---------- Client portal (client-side view) ---------- */
  const portal = {
    client: 'ТОВ «Северин»',
    matters: [{ title: 'Супровід ТОВ «Северин»', code: 'SEV-2026-04', status: 'У роботі', progress: 60 }],
    docs: [{ name: 'Договір про надання послуг', sub: 'Очікує вашого підпису', status: 'toSign' }, { name: 'Протокол розбіжностей', sub: 'Готовий до перегляду', status: 'view' }],
    invoices: [{ num: '№ 0142', period: 'Квітень 2026', amount: '61 250 ₴', status: 'paid' }, { num: '№ 0145', period: 'Травень 2026', amount: '24 000 ₴', status: 'sent' }],
    messages: [{ from: 'Марина Орлова', text: 'Підготували протокол розбіжностей за вашим договором. Перегляньте, будь ласка.', time: 'вчора', me: false }, { from: 'Ви', text: 'Дякую! Ознайомлюся сьогодні та підпишу.', time: 'вчора', me: true }],
  };

  return { team, roleOrder, permissions, matters, tasks, kanbanCols, timeEntries, invoices,
    clauseLib, laws, counterparties, cpSuggest, audit, versions, diffPairs, comments, approval, deadlines, obligations, litigation, review, esignQueue, conflictsDB, conflictSuggest, portal, userById };
})();
