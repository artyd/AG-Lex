/* ============================================================
   AG Lex — Document builder (Конструктор документів)
   Pick a type → fill parameters → AI assembles a draft from
   real Ukrainian clauses. Generated text is uk-only (like the
   clause library); the UI chrome is localized.
   ============================================================ */
import { useState, useEffect } from 'react';
import { Icon } from '../ui/Icon';
import { SectionTitle, toast } from '../ui/components';
import { api } from '../lib/api';

// Phase 3.3: handoff key the ContractAnalysis screen reads on mount when
// "Відкрити в аналізі" is used. A localStorage key keeps the change isolated
// to this module; full screen-level state lift is a follow-up.
const PENDING_ANALYSIS_KEY = 'aglex_pending_analysis';

function dbMoney(v) {
  if (v == null || v === '') return '';
  const n = String(v).replace(/[^\d]/g, '');
  return n ? Number(n).toLocaleString('uk-UA') : String(v);
}
const sec = (title, items) => ({ title, items: items.filter(Boolean) });

/* ---------- Generators (return a document model) ---------- */
function genServices(v) {
  const A = v.partyA || '[Замовник]', B = v.partyB || '[Виконавець]';
  const amount = dbMoney(v.amount);
  const pay = v.payment === 'stage'
    ? 'Оплата здійснюється поетапно: 30% — аванс протягом 5 (пʼяти) робочих днів з дати підписання Договору, 70% — протягом 10 (десяти) робочих днів після підписання акта приймання-передачі відповідного етапу.'
    : v.payment === 'post'
      ? 'Оплата здійснюється протягом 10 (десяти) банківських днів після підписання Сторонами акта приймання-передачі наданих послуг.'
      : 'Замовник здійснює 100% попередню оплату протягом 5 (пʼяти) банківських днів з дати підписання Договору.';
  return {
    kind: 'contract',
    heading: 'ДОГОВІР про надання послуг',
    number: '№ ____',
    intro: `${A}, в особі уповноваженого представника, що діє на підставі Статуту (далі — «Замовник»), з однієї сторони, та ${B}, в особі уповноваженого представника (далі — «Виконавець»), з іншої сторони, а разом — «Сторони», уклали цей Договір про таке:`,
    sections: [
      sec('Предмет Договору', [
        `Виконавець зобовʼязується надати Замовнику послуги: ${v.subject || '[предмет послуг]'}, а Замовник — прийняти та оплатити належно надані послуги.`,
        'Послуги надаються з дотриманням вимог Замовника та чинного законодавства України.',
      ]),
      sec('Ціна Договору та порядок оплати', [
        amount ? `Загальна вартість послуг за цим Договором становить ${amount} грн (без урахування/з урахуванням ПДВ — за домовленістю Сторін).` : 'Вартість послуг визначається у Додатках (специфікаціях) до цього Договору.',
        pay,
      ]),
      sec('Права та обовʼязки Сторін', [
        'Виконавець зобовʼязаний надати послуги якісно, у повному обсязі та в погоджені строки.',
        'Замовник зобовʼязаний прийняти послуги за актом приймання-передачі та оплатити їх у встановлений строк.',
      ]),
      sec('Відповідальність Сторін', [
        v.penalty && 'За порушення строків виконання грошових зобовʼязань винна Сторона сплачує іншій Стороні пеню в розмірі 0,1% від простроченої суми за кожен день прострочення, але не більше 10% від суми зобовʼязання.',
        v.liability && 'Відповідальність Виконавця обмежується розміром реальних збитків, але не більше загальної вартості Договору. Сторони не відповідають за упущену вигоду.',
        'У питаннях, не врегульованих цим Договором, Сторони керуються чинним законодавством України.',
      ]),
      v.nda && sec('Конфіденційність', [
        'Сторони зобовʼязуються не розголошувати конфіденційну інформацію, отриману під час виконання Договору, протягом строку його дії та 3 (трьох) років після припинення.',
      ]),
      sec('Строк дії та прикінцеві положення', [
        `Договір набирає чинності з моменту підписання та діє ${v.term || 'до повного виконання Сторонами своїх зобовʼязань'}.`,
        'Договір складено у двох примірниках, що мають однакову юридичну силу, по одному для кожної Сторони.',
      ]),
    ].filter(Boolean),
    signatures: [{ role: 'ЗАМОВНИК', name: A }, { role: 'ВИКОНАВЕЦЬ', name: B }],
  };
}

function genSupply(v) {
  const A = v.partyA || '[Покупець]', B = v.partyB || '[Постачальник]';
  const amount = dbMoney(v.amount);
  const pay = v.payment === 'stage' ? 'Оплата здійснюється поетапно: 30% — аванс, 70% — після поставки партії товару.'
    : v.payment === 'post' ? 'Оплата здійснюється протягом 10 банківських днів після поставки товару та підписання видаткової накладної.'
      : 'Покупець здійснює 100% попередню оплату вартості партії товару.';
  return {
    kind: 'contract',
    heading: 'ДОГОВІР постачання',
    number: '№ ____',
    intro: `${A} (далі — «Покупець»), з однієї сторони, та ${B} (далі — «Постачальник»), з іншої сторони, уклали цей Договір про таке:`,
    sections: [
      sec('Предмет Договору', [
        `Постачальник зобовʼязується передати у власність Покупця товар: ${v.subject || '[найменування товару]'}, а Покупець — прийняти та оплатити його.`,
        'Кількість, асортимент та ціна товару визначаються у специфікаціях, що є невідʼємною частиною Договору.',
      ]),
      sec('Ціна та порядок оплати', [
        amount ? `Загальна вартість товару за Договором становить ${amount} грн.` : 'Вартість товару визначається у специфікаціях до Договору.',
        pay,
      ]),
      sec('Умови та строк постачання', [
        `Постачання здійснюється протягом ${v.deliveryDays || '___'} календарних днів з дати оплати/замовлення на умовах, погоджених Сторонами.`,
        'Право власності та ризики випадкового знищення переходять до Покупця з моменту підписання видаткової накладної.',
      ]),
      v.warranty && sec('Якість та гарантія', [
        'Постачальник гарантує відповідність товару вимогам якості та супровідній документації. Гарантійний строк встановлюється виробником.',
        'У разі поставки товару неналежної якості Покупець має право вимагати заміни товару або повернення сплачених коштів.',
      ]),
      sec('Відповідальність Сторін', [
        v.penalty && 'За прострочення постачання або оплати винна Сторона сплачує пеню в розмірі 0,1% від вартості простроченого зобовʼязання за кожен день, але не більше 10%.',
        'Спори вирішуються шляхом переговорів, а у разі недосягнення згоди — у господарському суді за місцезнаходженням відповідача.',
      ]),
    ].filter(Boolean),
    signatures: [{ role: 'ПОКУПЕЦЬ', name: A }, { role: 'ПОСТАЧАЛЬНИК', name: B }],
  };
}

function genLease(v) {
  const A = v.partyA || '[Орендар]', B = v.partyB || '[Орендодавець]';
  const rent = dbMoney(v.rent);
  return {
    kind: 'contract',
    heading: 'ДОГОВІР оренди нежитлового приміщення',
    number: '№ ____',
    intro: `${B} (далі — «Орендодавець»), з однієї сторони, та ${A} (далі — «Орендар»), з іншої сторони, уклали цей Договір про таке:`,
    sections: [
      sec('Предмет Договору', [
        `Орендодавець передає, а Орендар приймає в строкове платне користування нежитлове приміщення за адресою: ${v.object || '[адреса приміщення]'}${v.area ? `, площею ${v.area} кв. м` : ''}.`,
        'Приміщення передається за актом приймання-передачі, що є невідʼємною частиною Договору.',
      ]),
      sec('Орендна плата та розрахунки', [
        rent ? `Розмір орендної плати становить ${rent} грн на місяць.` : 'Розмір орендної плати визначається додатковою угодою Сторін.',
        'Орендна плата сплачується щомісячно, не пізніше 5 (пʼятого) числа поточного місяця.',
        v.index && 'Орендна плата підлягає щорічній індексації відповідно до офіційного індексу інфляції.',
      ]),
      sec('Права та обовʼязки Сторін', [
        'Орендар зобовʼязаний використовувати приміщення за призначенням та підтримувати його належний стан.',
        'Орендодавець зобовʼязаний забезпечити безперешкодне користування приміщенням протягом строку оренди.',
      ]),
      sec('Строк дії та відповідальність', [
        `Договір укладено строком на ${v.months || '___'} місяців і набирає чинності з дати підписання акта приймання-передачі.`,
        v.penalty && 'За прострочення внесення орендної плати Орендар сплачує пеню в розмірі 0,1% від суми боргу за кожен день прострочення.',
      ]),
    ].filter(Boolean),
    signatures: [{ role: 'ОРЕНДОДАВЕЦЬ', name: B }, { role: 'ОРЕНДАР', name: A }],
  };
}

function genNda(v) {
  const A = v.partyA || '[Сторона 1]', B = v.partyB || '[Сторона 2]';
  const mutual = v.mutual;
  const penalty = dbMoney(v.penaltySum);
  return {
    kind: 'contract',
    heading: 'УГОДА про нерозголошення конфіденційної інформації (NDA)',
    number: '№ ____',
    intro: `${A} та ${B} (далі — «Сторони»), з метою: ${v.subject || '[мета розкриття інформації]'}, уклали цю Угоду про таке:`,
    sections: [
      sec('Предмет та визначення', [
        `Сторони домовились про захист конфіденційної інформації, що ${mutual ? 'взаємно розкривається Сторонами' : 'розкривається однією Стороною іншій'} під час співпраці.`,
        'Конфіденційною є будь-яка інформація технічного, комерційного, фінансового чи організаційного характеру, позначена як конфіденційна або така за своєю суттю.',
      ]),
      sec('Зобовʼязання щодо конфіденційності', [
        `Сторона, що отримала інформацію, зобовʼязується не розголошувати її третім особам та використовувати виключно для цілей співпраці.`,
        `Зобовʼязання конфіденційності діють протягом строку співпраці та ${v.years || 3} (___) років після її припинення.`,
      ]),
      sec('Відповідальність', [
        penalty ? `За розголошення конфіденційної інформації винна Сторона сплачує штраф у розмірі ${penalty} грн та відшкодовує завдані збитки.` : 'За розголошення конфіденційної інформації винна Сторона відшкодовує іншій Стороні завдані збитки у повному обсязі.',
        'Передача інформації на вимогу уповноважених державних органів не вважається порушенням за умови повідомлення іншої Сторони.',
      ]),
    ],
    signatures: [{ role: 'СТОРОНА 1', name: A }, { role: 'СТОРОНА 2', name: B }],
  };
}

function genClaim(v) {
  const A = v.partyA || '[Заявник]', B = v.partyB || '[Боржник]';
  const amount = dbMoney(v.amount);
  return {
    kind: 'letter',
    addressee: B,
    heading: 'ПРЕТЕНЗІЯ',
    sub: '(досудова вимога)',
    body: [
      `Між ${A} (далі — Заявник) та ${B} укладено ${v.contractRef || '[реквізити договору]'}.`,
      v.violation || '[опишіть суть порушення зобовʼязань контрагентом]',
      `Зазначені дії (бездіяльність) порушують умови договору та вимоги статей 525, 526 Цивільного кодексу України щодо належного виконання зобовʼязань.`,
      `На підставі викладеного, керуючись ст. 222 Господарського кодексу України, ВИМАГАЄМО: ${amount ? `сплатити заборгованість у розмірі ${amount} грн та ` : ''}усунути зазначені порушення протягом ${v.respDays || 7} календарних днів з дати отримання цієї претензії.`,
      `У разі невиконання вимог у встановлений строк Заявник буде змушений звернутися до господарського суду за захистом порушених прав з покладенням на Вас судових витрат.`,
    ],
    signOne: A,
  };
}

function genLawsuit(v) {
  const A = v.partyA || '[Позивач]', B = v.partyB || '[Відповідач]';
  const amount = dbMoney(v.amount);
  return {
    kind: 'letter',
    addressee: v.court || '[Найменування господарського суду]',
    heading: 'ПОЗОВНА ЗАЯВА',
    sub: v.subject ? `про ${v.subject}` : 'про стягнення заборгованості',
    partiesLine: `Позивач: ${A}    Відповідач: ${B}${amount ? `    Ціна позову: ${amount} грн` : ''}`,
    body: [
      `Між Позивачем та Відповідачем виникли правовідносини, що є предметом спору: ${v.subject || '[предмет позову]'}.`,
      v.grounds || '[викладіть обставини та підстави позову з посиланням на докази]',
      `Дії Відповідача порушують права та законні інтереси Позивача, що відповідно до ст. 15, 16 Цивільного кодексу України підлягають судовому захисту.`,
      `Враховуючи наведене, керуючись ст. 4, 162, 164 Господарського процесуального кодексу України, ПРОШУ: задовольнити позов у повному обсязі${amount ? ` та стягнути з Відповідача ${amount} грн` : ''}, а також покласти на Відповідача судові витрати.`,
      'Додатки: 1) докази направлення претензії та відповідь на неї; 2) копії договору та первинних документів; 3) докази сплати судового збору.',
    ],
    signOne: A,
  };
}

/* ---------- Document type registry ---------- */
const F = (key, label, opt = {}) => ({ key, label, ...opt });
const DOC_TYPES = [
  { id: 'services', icon: 'doc', name: 'Договір про надання послуг', desc: 'Виконавець надає послуги Замовнику', gen: genServices,
    fields: [
      F('partyA', 'Замовник (повна назва)'), F('partyB', 'Виконавець (повна назва)'),
      F('subject', 'Предмет послуг', { full: true }),
      F('amount', 'Загальна сума, грн', { type: 'num' }), F('term', 'Строк дії', { placeholder: 'до 31.12.2026' }),
      F('city', 'Місто укладення', { def: 'м. Київ' }),
      F('payment', 'Порядок оплати', { type: 'select', options: [['pre', '100% передоплата'], ['stage', 'Поетапно 30/70'], ['post', 'Післяплата']], def: 'stage' }),
    ],
    toggles: [F('penalty', 'Неустойка (пеня 0,1%/день)', { def: true }), F('liability', 'Обмеження відповідальності', { def: true }), F('nda', 'Умова конфіденційності')] },
  { id: 'supply', icon: 'building', name: 'Договір постачання', desc: 'Постачання товару покупцю', gen: genSupply,
    fields: [
      F('partyA', 'Покупець'), F('partyB', 'Постачальник'),
      F('subject', 'Найменування товару', { full: true }),
      F('amount', 'Сума, грн', { type: 'num' }), F('deliveryDays', 'Строк постачання, днів', { type: 'num', def: '14' }),
      F('city', 'Місто', { def: 'м. Київ' }),
      F('payment', 'Порядок оплати', { type: 'select', options: [['pre', '100% передоплата'], ['stage', 'Поетапно 30/70'], ['post', 'Післяплата']], def: 'post' }),
    ],
    toggles: [F('warranty', 'Гарантія якості', { def: true }), F('penalty', 'Неустойка за прострочення', { def: true })] },
  { id: 'lease', icon: 'folder', name: 'Договір оренди', desc: 'Оренда нежитлового приміщення', gen: genLease,
    fields: [
      F('partyA', 'Орендар'), F('partyB', 'Орендодавець'),
      F('object', 'Адреса приміщення', { full: true }),
      F('area', 'Площа, кв. м', { type: 'num' }), F('rent', 'Орендна плата, грн/міс', { type: 'num' }),
      F('months', 'Строк, місяців', { type: 'num', def: '12' }), F('city', 'Місто', { def: 'м. Київ' }),
    ],
    toggles: [F('index', 'Індексація плати'), F('penalty', 'Неустойка за прострочення', { def: true })] },
  { id: 'nda', icon: 'book', name: 'Угода про нерозголошення (NDA)', desc: 'Захист конфіденційної інформації', gen: genNda,
    fields: [
      F('partyA', 'Сторона 1'), F('partyB', 'Сторона 2'),
      F('subject', 'Мета розкриття інформації', { full: true }),
      F('years', 'Строк дії, років', { type: 'num', def: '3' }), F('penaltySum', 'Штраф за розголошення, грн', { type: 'num' }),
      F('city', 'Місто', { def: 'м. Київ' }),
    ],
    toggles: [F('mutual', 'Взаємна (двостороння)', { def: true })] },
  { id: 'claim', icon: 'alert', name: 'Претензія', desc: 'Досудова вимога до контрагента', gen: genClaim,
    fields: [
      F('partyA', 'Заявник (ви)'), F('partyB', 'Боржник / контрагент'),
      F('contractRef', 'Реквізити договору', { full: true }),
      F('violation', 'Суть порушення', { full: true, area: true }),
      F('amount', 'Сума вимоги, грн', { type: 'num' }), F('respDays', 'Строк відповіді, днів', { type: 'num', def: '7' }),
      F('city', 'Місто', { def: 'м. Київ' }),
    ], toggles: [] },
  { id: 'lawsuit', icon: 'scales', name: 'Позовна заява', desc: 'Звернення до господарського суду', gen: genLawsuit,
    fields: [
      F('court', 'Найменування суду', { full: true, def: 'Господарський суд міста Києва' }),
      F('partyA', 'Позивач'), F('partyB', 'Відповідач'),
      F('subject', 'Предмет позову', { full: true }),
      F('grounds', 'Підстави позову', { full: true, area: true }),
      F('amount', 'Ціна позову, грн', { type: 'num' }), F('city', 'Місто', { def: 'м. Київ' }),
    ], toggles: [] },
];

/* ---------- Helpers ---------- */
function dbToday() { const d = new Date(2026, 5, 9), p = x => String(x).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`; }
function dbDefaults(type) { const o = {}; [...(type.fields || []), ...(type.toggles || [])].forEach(f => { o[f.key] = f.def != null ? f.def : (f.type === 'select' ? (f.options[0][0]) : (f.type === 'num' ? '' : '')); }); return o; }
function dbDocToText(doc, v) {
  const L = [];
  if (doc.kind === 'contract') {
    L.push(doc.heading + ' ' + (doc.number || ''));
    L.push((v.city || 'м. Київ') + '\t' + dbToday());
    L.push('', doc.intro, '');
    doc.sections.forEach((s, i) => { L.push(`${i + 1}. ${s.title}`); s.items.forEach((it, k) => L.push(`${i + 1}.${k + 1}. ${it}`)); L.push(''); });
    doc.signatures.forEach(sg => L.push(`${sg.role}: ${sg.name}    _____________ (підпис)`));
  } else {
    L.push('Кому: ' + doc.addressee); L.push('');
    L.push(doc.heading + (doc.sub ? ' ' + doc.sub : '')); L.push('');
    if (doc.partiesLine) { L.push(doc.partiesLine); L.push(''); }
    doc.body.forEach(b => { L.push(b); L.push(''); });
    L.push(`${dbToday()}    ${doc.signOne}    _____________ (підпис)`);
  }
  return L.join('\n');
}

/* ---------- Generation overlay ---------- */
function BuildOverlay({ t }) {
  const [step, setStep] = useState(0);
  const labels = [t.builderGenStep1, t.builderGenStep2, t.builderGenStep3, t.builderGenStep4];
  useEffect(() => { const id = setInterval(() => setStep(s => Math.min(s + 1, 4)), 480); return () => clearInterval(id); }, []);
  return (
    <div className="dbuild-overlay">
      <div className="dbuild-spark"><Icon name="wand" size={26} /></div>
      <div style={{ fontWeight: 700, fontSize: 18, marginTop: 14 }}>{t.builderGening}</div>
      <div className="dbuild-prog"><span style={{ width: (step / 4 * 100) + '%' }} /></div>
      <div className="dbuild-steps">
        {labels.map((l, i) => (
          <div key={i} className={'dbuild-stp' + (i < step ? ' done' : i === step ? ' on' : '')}>
            <Icon name={i < step ? 'checkCircle' : 'clock'} size={16} /> {l}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Document sheet ---------- */
function DocSheet({ doc, v }) {
  if (doc.kind === 'letter') {
    return (
      <div className="dbuild-sheet">
        <div className="dsheet-to">{doc.addressee}</div>
        <h1 className="dsheet-h">{doc.heading}{doc.sub ? <span className="dsheet-sub"> {doc.sub}</span> : null}</h1>
        {doc.partiesLine ? <div className="dsheet-parties">{doc.partiesLine}</div> : null}
        <div className="dsheet-body">
          {doc.body.map((b, i) => <p key={i}>{b}</p>)}
        </div>
        <div className="dsheet-signone">
          <span>{dbToday()}</span>
          <span>{doc.signOne} &nbsp;_______________</span>
        </div>
      </div>
    );
  }
  return (
    <div className="dbuild-sheet">
      <h1 className="dsheet-h">{doc.heading} <span className="dsheet-num">{doc.number}</span></h1>
      <div className="dsheet-meta"><span>{v.city || 'м. Київ'}</span><span>{dbToday()}</span></div>
      <p className="dsheet-intro">{doc.intro}</p>
      {doc.sections.map((s, i) => (
        <div key={i} className="dsheet-sec">
          <div className="dsheet-sec-h">{i + 1}. {s.title}</div>
          {s.items.map((it, k) => <p key={k} className="dsheet-item"><span className="dsheet-no">{i + 1}.{k + 1}.</span> {it}</p>)}
        </div>
      ))}
      <div className="dsheet-signs">
        {doc.signatures.map((sg, i) => (
          <div key={i} className="dsheet-sign">
            <div className="dsheet-role">{sg.role}</div>
            <div className="dsheet-name">{sg.name}</div>
            <div className="dsheet-line">_______________</div>
            <div className="dsheet-mp">підпис · М.П.</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- API document renderer (Phase 3.3) ---------- */
function ApiDocSheet({ apiDoc }) {
  if (!apiDoc) return null;
  return (
    <div className="dbuild-sheet" style={{ padding: 'var(--s6)' }}>
      <pre style={{
        whiteSpace: 'pre-wrap',
        fontFamily: 'inherit',
        fontSize: 14,
        lineHeight: 1.6,
        margin: 0,
      }}>{apiDoc.document_markdown}</pre>
      {apiDoc.warnings && apiDoc.warnings.length > 0 ? (
        <div style={{ marginTop: 'var(--s5)', padding: 'var(--s4)',
                      border: '1px solid var(--risk-med)', borderRadius: 8 }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--risk-med)' }}>
            <Icon name="alert" size={14} /> Перевірте посилання
          </div>
          <ul style={{ paddingLeft: 18, fontSize: 13, color: 'var(--text-2)' }}>
            {apiDoc.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      ) : null}
      {apiDoc.articles_cited && apiDoc.articles_cited.length > 0 ? (
        <div style={{ marginTop: 'var(--s5)', fontSize: 13, color: 'var(--text-3)' }}>
          <Icon name="scales" size={13} /> Посилання: {apiDoc.articles_cited.join(', ')}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Main builder ---------- */
// Map prototype type IDs (`services`, `nda`, …) to backend `type` strings.
const TYPE_ID_TO_API = {
  services: 'services',
  supply: 'supply',
  lease: 'lease',
  nda: 'nda',
  claim: 'claim',
  lawsuit: 'lawsuit',
};

function DocBuilder({ t, setRoute, user }) {
  const [phase, setPhase] = useState('pick'); // pick | form | gen | done
  const [typeId, setTypeId] = useState(null);
  const [v, setV] = useState({});
  const [doc, setDoc] = useState(null);           // local generator result (fallback)
  const [apiDoc, setApiDoc] = useState(null);     // /api/generate-document result (primary)
  const [drafts, setDrafts] = useState([]);
  const [draftsTab, setDraftsTab] = useState('mine');  // 'mine' | 'team'
  const [usingFallback, setUsingFallback] = useState(false);
  const type = DOC_TYPES.find(d => d.id === typeId);
  const myUserId = user && user.id;

  // Fix 1: hydrate drafts from the API on mount. The backend already filters
  // to (mine OR is_shared = TRUE), so the client just needs to bucket them
  // into the two tabs.
  function refreshDrafts() {
    return api.drafts.list()
      .then(rows => {
        setDrafts(rows.map(r => ({
          id: r.id,
          typeId: r.typeId,
          name: r.name,
          party: r.party || '',
          date: (r.createdAt || '').slice(0, 10).split('-').reverse().join('.'),
          values: r.params || {},
          documentMarkdown: r.documentMarkdown || '',
          userId: r.userId,
          isShared: !!r.isShared,
          authorName: r.authorName || '',
        })));
      })
      .catch(() => {
        try { setDrafts(JSON.parse(localStorage.getItem('aglex_drafts') || '[]')); }
        catch (_e) { setDrafts([]); }
      });
  }

  useEffect(() => {
    let cancelled = false;
    refreshDrafts().then(() => { if (cancelled) setDrafts([]); });
    return () => { cancelled = true; };
  }, []);

  const myDrafts = drafts.filter(d => d.userId != null && d.userId === myUserId);
  const teamDrafts = drafts.filter(d => d.isShared);
  const visibleDrafts = draftsTab === 'mine' ? myDrafts : teamDrafts;

  // Local generator fallback when the API fails. The original prototype timer
  // is kept so the UI still shows the "generating" animation in dev mode.
  useEffect(() => {
    if (phase !== 'gen' || !usingFallback) return;
    const id = setTimeout(() => { setDoc(type.gen(v)); setPhase('done'); }, 2150);
    return () => clearTimeout(id);
  }, [phase, usingFallback]);

  const pick = (d) => {
    setTypeId(d.id); setV(dbDefaults(d));
    setDoc(null); setApiDoc(null); setUsingFallback(false);
    setPhase('form');
  };
  const set = (k, val) => setV(p => ({ ...p, [k]: val }));

  const generate = async () => {
    if (!String(v.partyA || '').trim() || !String(v.partyB || '').trim()) {
      toast(t.builderRequired, 'alert'); return;
    }
    setPhase('gen');
    setDoc(null); setApiDoc(null); setUsingFallback(false);

    // Split form values into `params` (text fields) and `options` (booleans).
    const params = {}, options = {};
    Object.entries(v).forEach(([k, val]) => {
      if (typeof val === 'boolean') options[k] = val;
      else params[k] = val;
    });

    try {
      const res = await api.request('/api/generate-document', {
        method: 'POST',
        body: { type: TYPE_ID_TO_API[typeId] || typeId, params, options },
      });
      setApiDoc(res);
      setPhase('done');
    } catch (_e) {
      // Offline / RBAC / network → flip to deterministic local generator so
      // the demo experience stays interactive.
      setUsingFallback(true);
      // The fallback useEffect picks up here once usingFallback flips true.
    }
  };

  const restart = () => {
    setPhase('pick'); setTypeId(null); setV({});
    setDoc(null); setApiDoc(null); setUsingFallback(false);
  };

  const copy = () => {
    const txt = apiDoc ? apiDoc.document_markdown : (doc ? dbDocToText(doc, v) : '');
    try { navigator.clipboard.writeText(txt); } catch (_e) {}
    toast(t.builderCopied, 'check');
  };

  const save = async () => {
    const heading = apiDoc
      ? (apiDoc.type_label || DOC_TYPES.find(x => x.id === typeId)?.name || 'Документ')
      : doc.heading;
    const documentMarkdown = apiDoc ? apiDoc.document_markdown : dbDocToText(doc, v);
    try {
      const created = await api.drafts.create({
        typeId,
        name: heading,
        party: v.partyA || v.partyB || '',
        documentMarkdown,
        params: v,
        options: apiDoc ? null : {},
        createdAt: new Date().toISOString(),
      });
      setDrafts(ds => [{
        id: created.id, typeId: created.typeId, name: created.name,
        party: created.party || '', date: (created.createdAt || '').slice(0, 10).split('-').reverse().join('.'),
        values: created.params || {}, documentMarkdown: created.documentMarkdown,
        userId: created.userId, isShared: !!created.isShared,
        authorName: created.authorName || '',
      }, ...ds].slice(0, 24));
      // Fresh drafts land as personal — make sure the user actually sees the
      // row by snapping the visible tab back to "Мої".
      setDraftsTab('mine');
      toast(t.builderSaved, 'checkCircle');
    } catch (_e) {
      // Offline save → stash locally so the demo still shows the draft list.
      const entry = { id: 'dr' + Date.now(), typeId, name: heading,
                      party: v.partyA || v.partyB || '', date: dbToday(),
                      values: v, documentMarkdown };
      const next = [entry, ...drafts].slice(0, 8);
      setDrafts(next);
      try { localStorage.setItem('aglex_drafts', JSON.stringify(next)); } catch (_e2) {}
      toast(t.builderSaved, 'checkCircle');
    }
  };

  const openInAnalysis = () => {
    const markdown = apiDoc ? apiDoc.document_markdown : (doc ? dbDocToText(doc, v) : '');
    if (!markdown) { toast('Нічого передавати', 'alert'); return; }
    try {
      localStorage.setItem(PENDING_ANALYSIS_KEY, JSON.stringify({
        markdown,
        typeId,
        ts: Date.now(),
      }));
    } catch (_e) {}
    setRoute('analyze');
  };

  const shareDraft = async (e, dr) => {
    e.stopPropagation();  // don't trigger row's openDraft
    try {
      await api.request(`/api/drafts/${dr.id}/share`, { method: 'PATCH' });
      toast('Поділено з командою', 'check');
      await refreshDrafts();
      setDraftsTab('team');
    } catch (_e) {
      toast('Не вдалося поділитися', 'alert');
    }
  };

  const openDraft = (dr) => {
    setTypeId(dr.typeId);
    setV(dr.values || {});
    if (dr.documentMarkdown) {
      setApiDoc({
        document_markdown: dr.documentMarkdown,
        layout: 'contract',
        articles_cited: [],
        warnings: [],
        type: dr.typeId,
        type_label: (DOC_TYPES.find(x => x.id === dr.typeId) || {}).name || '',
      });
      setDoc(null);
    } else {
      const dt = DOC_TYPES.find(x => x.id === dr.typeId);
      setDoc(dt ? dt.gen(dr.values || {}) : null);
      setApiDoc(null);
    }
    setPhase('done');
  };

  /* ----- PICK ----- */
  if (phase === 'pick') {
    return (
      <div className="page view-enter"><div className="page-narrow">
        <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 'var(--s5)' }}>{t.builderSub}</div>
        <div className="dbuild-types">
          {DOC_TYPES.map(d => (
            <button key={d.id} className="card dbuild-type" onClick={() => pick(d)}>
              <span className="dbuild-type-ic"><Icon name={d.icon} size={20} /></span>
              <span className="dbuild-type-name">{d.name}</span>
              <span className="dbuild-type-desc">{d.desc}</span>
              <span className="dbuild-type-go"><Icon name="arrowR" size={16} /></span>
            </button>
          ))}
        </div>
        {(myDrafts.length > 0 || teamDrafts.length > 0) && (
          <div style={{ marginTop: 'var(--s7)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 'var(--s4)' }}>
              <SectionTitle>{t.library} · {t.builder}</SectionTitle>
              <div className="seg" style={{ marginLeft: 'auto' }}>
                <button className={draftsTab === 'mine' ? 'on' : ''} onClick={() => setDraftsTab('mine')}>
                  Мої <span style={{ color: 'var(--text-3)', marginLeft: 4 }}>{myDrafts.length}</span>
                </button>
                <button className={draftsTab === 'team' ? 'on' : ''} onClick={() => setDraftsTab('team')}>
                  Командні <span style={{ color: 'var(--text-3)', marginLeft: 4 }}>{teamDrafts.length}</span>
                </button>
              </div>
            </div>
            {visibleDrafts.length === 0 ? (
              <div className="card" style={{ padding: 'var(--s5)', color: 'var(--text-3)', textAlign: 'center', fontSize: 13 }}>
                {draftsTab === 'mine' ? 'Поки що жодного особистого чернетки.' : 'У команді ще немає поділених чернеток.'}
              </div>
            ) : (
              <div className="card" style={{ overflow: 'hidden' }}>
                <table className="lib-table">
                  <tbody>
                    {visibleDrafts.map(dr => {
                      const isMine = dr.userId != null && dr.userId === myUserId;
                      const showShare = isMine && !dr.isShared && draftsTab === 'mine';
                      return (
                        <tr key={dr.id} onClick={() => openDraft(dr)} style={{ cursor: 'pointer' }}>
                          <td style={{ width: 46 }}><span className="dbuild-mini-ic"><Icon name={(DOC_TYPES.find(x => x.id === dr.typeId) || {}).icon || 'doc'} size={15} /></span></td>
                          <td>
                            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{dr.name}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                              {dr.party}
                              {draftsTab === 'team' && dr.authorName ? (
                                <span style={{ marginLeft: dr.party ? 8 : 0 }}>· {dr.authorName}</span>
                              ) : null}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {showShare ? (
                              <button
                                className="btn btn-subtle btn-sm"
                                onClick={(e) => shareDraft(e, dr)}
                                title="Поділитися з командою"
                                style={{ marginRight: 8 }}
                              >
                                <Icon name="library" size={14} /> Поділитися
                              </button>
                            ) : null}
                            <span style={{ color: 'var(--text-3)', fontSize: 12.5, fontFamily: 'var(--font-mono)' }}>{dr.date}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div></div>
    );
  }

  /* ----- FORM ----- */
  if (phase === 'form' || phase === 'gen') {
    return (
      <div className="page view-enter"><div className="page-narrow" style={{ maxWidth: 760 }}>
        <button className="btn btn-subtle btn-sm" onClick={restart} style={{ marginBottom: 'var(--s4)' }}><Icon name="chevR" size={15} style={{ transform: 'rotate(180deg)' }} /> {t.builderPick}</button>
        <div className="dbuild-form-head">
          <span className="dbuild-type-ic"><Icon name={type.icon} size={20} /></span>
          <div><div style={{ fontWeight: 700, fontSize: 17 }}>{type.name}</div><div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{type.desc}</div></div>
        </div>

        {phase === 'gen' ? <BuildOverlay t={t} /> : (
          <>
            <div className="dbuild-form">
              {type.fields.map(f => (
                <label key={f.key} className={'field-row' + (f.full ? ' field-full' : '')}>
                  <span className="field-label">{f.label}</span>
                  {f.type === 'select'
                    ? <select className="field" value={v[f.key]} onChange={e => set(f.key, e.target.value)}>{f.options.map(([val, lbl]) => <option key={val} value={val}>{lbl}</option>)}</select>
                    : f.area
                      ? <textarea className="field" rows={3} value={v[f.key] || ''} onChange={e => set(f.key, e.target.value)} placeholder={f.placeholder || ''} />
                      : <input className="field" value={v[f.key] || ''} inputMode={f.type === 'num' ? 'numeric' : undefined} onChange={e => set(f.key, e.target.value)} placeholder={f.placeholder || ''} />}
                </label>
              ))}
            </div>
            {type.toggles && type.toggles.length > 0 && (
              <div className="dbuild-toggles">
                <div className="dbuild-toggles-h">{t.builderClauses}</div>
                {type.toggles.map(f => (
                  <button key={f.key} className={'dbuild-toggle' + (v[f.key] ? ' on' : '')} onClick={() => set(f.key, !v[f.key])}>
                    <span className="dbuild-tg-track"><span className="dbuild-tg-knob" /></span>
                    {f.label}
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--s5)' }}>
              <button className="btn btn-primary" onClick={generate}><Icon name="wand" size={16} /> {t.builderGen}</button>
            </div>
          </>
        )}
      </div></div>
    );
  }

  /* ----- DONE ----- */
  return (
    <div className="page view-enter"><div className="page-narrow" style={{ maxWidth: 820 }}>
      <div className="dbuild-done-bar">
        <button className="btn btn-subtle btn-sm" onClick={restart}><Icon name="plus" size={15} /> {t.builderRestart}</button>
        <span className="dbuild-ready"><Icon name="checkCircle" size={14} /> {t.builderReady}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => { setDoc(null); setPhase('gen'); }}><Icon name="refresh" size={15} /> {t.builderRegen}</button>
          <button className="btn btn-ghost btn-sm" onClick={copy}><Icon name="doc" size={15} /> {t.builderCopy}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => toast(t.builderDownloaded, 'download')}><Icon name="download" size={15} /> {t.builderDownload}</button>
          <button className="btn btn-ghost btn-sm" onClick={save}><Icon name="library" size={15} /> {t.builderSave}</button>
          <button className="btn btn-primary btn-sm" onClick={openInAnalysis}><Icon name="scan" size={15} /> {t.builderOpen}</button>
        </div>
      </div>
      {usingFallback ? (
        <div className="tr-note" style={{ marginBottom: 'var(--s4)', color: 'var(--risk-med)' }}>
          <Icon name="alert" size={13} /> Показано офлайн-демо (API недоступний — увійдіть та перевірте право `ai`).
        </div>
      ) : null}
      {apiDoc ? <ApiDocSheet apiDoc={apiDoc} /> : doc ? <DocSheet doc={doc} v={v} /> : null}
    </div></div>
  );
}

export { DocBuilder };
