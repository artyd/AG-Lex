/* ============================================================
   AG Lex — icon set. <Icon name size /> renders Font Awesome
   Free 7.x Solid glyphs (brands for OS logos). Same call-site
   API as before — `stroke` / `fill` props are accepted and
   ignored so older usages keep working.

   The "3D" feel comes from the tile wrapper (.hub-ic /
   .dropzone-ic / .file-chip-ic / .icon-3d) — see CSS. The icon
   itself is a single-color FA Solid path that picks up
   currentColor from its container, so it follows accent/theme.
   ============================================================ */
import alertSvg from '@fortawesome/fontawesome-free/svgs/solid/triangle-exclamation.svg?raw';
import arrowRSvg from '@fortawesome/fontawesome-free/svgs/solid/arrow-right.svg?raw';
import bellSvg from '@fortawesome/fontawesome-free/svgs/solid/bell.svg?raw';
import bookSvg from '@fortawesome/fontawesome-free/svgs/solid/book-open.svg?raw';
import buildingSvg from '@fortawesome/fontawesome-free/svgs/solid/building.svg?raw';
import calendarSvg from '@fortawesome/fontawesome-free/svgs/solid/calendar-days.svg?raw';
import chatSvg from '@fortawesome/fontawesome-free/svgs/solid/comment-dots.svg?raw';
import checkSvg from '@fortawesome/fontawesome-free/svgs/solid/check.svg?raw';
import checkCircleSvg from '@fortawesome/fontawesome-free/svgs/solid/circle-check.svg?raw';
import chevDSvg from '@fortawesome/fontawesome-free/svgs/solid/chevron-down.svg?raw';
import chevRSvg from '@fortawesome/fontawesome-free/svgs/solid/chevron-right.svg?raw';
import circleSvg from '@fortawesome/fontawesome-free/svgs/solid/circle.svg?raw';
import clientsSvg from '@fortawesome/fontawesome-free/svgs/solid/users.svg?raw';
import clockSvg from '@fortawesome/fontawesome-free/svgs/solid/clock.svg?raw';
import coinsSvg from '@fortawesome/fontawesome-free/svgs/solid/coins.svg?raw';
import dashboardSvg from '@fortawesome/fontawesome-free/svgs/solid/gauge-high.svg?raw';
import docSvg from '@fortawesome/fontawesome-free/svgs/solid/file-lines.svg?raw';
import downloadSvg from '@fortawesome/fontawesome-free/svgs/solid/download.svg?raw';
import euroSvg from '@fortawesome/fontawesome-free/svgs/solid/euro-sign.svg?raw';
import filterSvg from '@fortawesome/fontawesome-free/svgs/solid/filter.svg?raw';
import flagSvg from '@fortawesome/fontawesome-free/svgs/solid/flag.svg?raw';
import folderSvg from '@fortawesome/fontawesome-free/svgs/solid/folder.svg?raw';
import gavelSvg from '@fortawesome/fontawesome-free/svgs/solid/gavel.svg?raw';
import globeSvg from '@fortawesome/fontawesome-free/svgs/solid/globe.svg?raw';
import hourglassSvg from '@fortawesome/fontawesome-free/svgs/solid/hourglass-half.svg?raw';
import librarySvg from '@fortawesome/fontawesome-free/svgs/solid/book-bookmark.svg?raw';
import menuSvg from '@fortawesome/fontawesome-free/svgs/solid/bars.svg?raw';
import monitorSvg from '@fortawesome/fontawesome-free/svgs/solid/display.svg?raw';
import moonSvg from '@fortawesome/fontawesome-free/svgs/solid/moon.svg?raw';
import pauseSvg from '@fortawesome/fontawesome-free/svgs/solid/pause.svg?raw';
import paySvg from '@fortawesome/fontawesome-free/svgs/solid/credit-card.svg?raw';
import penSvg from '@fortawesome/fontawesome-free/svgs/solid/pen-to-square.svg?raw';
import playSvg from '@fortawesome/fontawesome-free/svgs/solid/play.svg?raw';
import plusSvg from '@fortawesome/fontawesome-free/svgs/solid/plus.svg?raw';
import refreshSvg from '@fortawesome/fontawesome-free/svgs/solid/arrow-rotate-right.svg?raw';
import scalesSvg from '@fortawesome/fontawesome-free/svgs/solid/scale-balanced.svg?raw';
import scanSvg from '@fortawesome/fontawesome-free/svgs/solid/magnifying-glass-chart.svg?raw';
import searchSvg from '@fortawesome/fontawesome-free/svgs/solid/magnifying-glass.svg?raw';
import sendSvg from '@fortawesome/fontawesome-free/svgs/solid/paper-plane.svg?raw';
import settingsSvg from '@fortawesome/fontawesome-free/svgs/solid/gear.svg?raw';
import shieldSvg from '@fortawesome/fontawesome-free/svgs/solid/shield-halved.svg?raw';
import sparkleSvg from '@fortawesome/fontawesome-free/svgs/solid/star.svg?raw';
import sunSvg from '@fortawesome/fontawesome-free/svgs/solid/sun.svg?raw';
import templatesSvg from '@fortawesome/fontawesome-free/svgs/solid/file-contract.svg?raw';
import uploadSvg from '@fortawesome/fontawesome-free/svgs/solid/cloud-arrow-up.svg?raw';
import wandSvg from '@fortawesome/fontawesome-free/svgs/solid/wand-magic-sparkles.svg?raw';
import xSvg from '@fortawesome/fontawesome-free/svgs/solid/xmark.svg?raw';

// Expanded set for the contract-builder / intake / international supply
// flows. Each new key has a specific semantic role — we don't just dump
// the whole FA pack to keep the bundle small. Pick the right name when
// adding a new call-site; if you need a glyph that isn't here, add ONE
// import + ONE RAW entry below rather than reaching for a generic.
import contractSvg from '@fortawesome/fontawesome-free/svgs/solid/file-signature.svg?raw';
import handshakeSvg from '@fortawesome/fontawesome-free/svgs/solid/handshake.svg?raw';
import invoiceSvg from '@fortawesome/fontawesome-free/svgs/solid/file-invoice-dollar.svg?raw';
import warehouseSvg from '@fortawesome/fontawesome-free/svgs/solid/warehouse.svg?raw';
import truckSvg from '@fortawesome/fontawesome-free/svgs/solid/truck-fast.svg?raw';
import shipSvg from '@fortawesome/fontawesome-free/svgs/solid/ship.svg?raw';
import boxesSvg from '@fortawesome/fontawesome-free/svgs/solid/boxes-stacked.svg?raw';
import bankSvg from '@fortawesome/fontawesome-free/svgs/solid/building-columns.svg?raw';
import certificateSvg from '@fortawesome/fontawesome-free/svgs/solid/award.svg?raw';
import stampSvg from '@fortawesome/fontawesome-free/svgs/solid/stamp.svg?raw';
import clipboardSvg from '@fortawesome/fontawesome-free/svgs/solid/clipboard-list.svg?raw';
import passportSvg from '@fortawesome/fontawesome-free/svgs/solid/passport.svg?raw';
import infoSvg from '@fortawesome/fontawesome-free/svgs/solid/circle-info.svg?raw';
import sparkleAltSvg from '@fortawesome/fontawesome-free/svgs/solid/wand-sparkles.svg?raw';
import minusSvg from '@fortawesome/fontawesome-free/svgs/solid/minus.svg?raw';
import lockSvg from '@fortawesome/fontawesome-free/svgs/solid/lock.svg?raw';
import keySvg from '@fortawesome/fontawesome-free/svgs/solid/key.svg?raw';
import receiptSvg from '@fortawesome/fontawesome-free/svgs/solid/receipt.svg?raw';
import briefcaseSvg from '@fortawesome/fontawesome-free/svgs/solid/briefcase.svg?raw';
import barcodeSvg from '@fortawesome/fontawesome-free/svgs/solid/barcode.svg?raw';

import appleSvg from '@fortawesome/fontawesome-free/svgs/brands/apple.svg?raw';
import linuxSvg from '@fortawesome/fontawesome-free/svgs/brands/linux.svg?raw';
import windowsSvg from '@fortawesome/fontawesome-free/svgs/brands/windows.svg?raw';

const RAW = {
  alert: alertSvg,
  arrowR: arrowRSvg,
  bell: bellSvg,
  book: bookSvg,
  building: buildingSvg,
  calendar: calendarSvg,
  chat: chatSvg,
  check: checkSvg,
  checkCircle: checkCircleSvg,
  chevD: chevDSvg,
  chevR: chevRSvg,
  circle: circleSvg,
  clients: clientsSvg,
  clock: clockSvg,
  coins: coinsSvg,
  dashboard: dashboardSvg,
  doc: docSvg,
  download: downloadSvg,
  euro: euroSvg,
  filter: filterSvg,
  flag: flagSvg,
  folder: folderSvg,
  gavel: gavelSvg,
  globe: globeSvg,
  hourglass: hourglassSvg,
  library: librarySvg,
  menu: menuSvg,
  monitor: monitorSvg,
  moon: moonSvg,
  pause: pauseSvg,
  pay: paySvg,
  pen: penSvg,
  play: playSvg,
  plus: plusSvg,
  refresh: refreshSvg,
  scales: scalesSvg,
  scan: scanSvg,
  search: searchSvg,
  send: sendSvg,
  settings: settingsSvg,
  shield: shieldSvg,
  sparkle: sparkleSvg,
  sun: sunSvg,
  templates: templatesSvg,
  upload: uploadSvg,
  wand: wandSvg,
  x: xSvg,

  apple: appleSvg,
  linux: linuxSvg,
  windows: windowsSvg,

  // Expanded set (Phase polish)
  contract:    contractSvg,    // signed-doc — better than `doc` for contracts
  handshake:   handshakeSvg,   // negotiation / parties / B2B
  invoice:     invoiceSvg,     // money + doc
  warehouse:   warehouseSvg,   // supply chain / consignee
  truck:       truckSvg,       // delivery (Incoterms)
  ship:        shipSvg,        // CIF/FOB shipping
  boxes:       boxesSvg,       // goods / quantity
  bank:        bankSvg,        // banking details
  certificate: certificateSvg, // certificates of analysis / quality
  stamp:       stampSvg,       // approval / official seal
  clipboard:   clipboardSvg,   // intake form / checklist
  passport:    passportSvg,    // signatories / identity
  info:        infoSvg,        // info hint
  sparkleAlt:  sparkleAltSvg,  // alternative AI/wand glyph
  minus:       minusSvg,
  lock:        lockSvg,        // confidentiality / NDA
  key:         keySvg,         // access / permissions
  receipt:     receiptSvg,     // payment terms
  briefcase:   briefcaseSvg,   // professional / role
  barcode:     barcodeSvg,     // HS code / SKU
};

function parseRaw(raw) {
  const vbMatch = raw.match(/viewBox="([^"]+)"/);
  const viewBox = vbMatch ? vbMatch[1] : '0 0 512 512';
  const inner = raw
    .replace(/<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\sfill="(?!none)[^"]*"/g, ' fill="currentColor"')
    .trim();
  const [, , wStr, hStr] = viewBox.split(/\s+/);
  const vbW = Number(wStr) || 512;
  const vbH = Number(hStr) || 512;
  return { viewBox, inner, vbW, vbH };
}

const ICONS = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [k, parseRaw(v)]),
);

export function Icon({ name, size = 20, style, className }) {
  const ic = ICONS[name];
  if (!ic) return null;
  const ar = ic.vbW / ic.vbH;
  const w = ar >= 1 ? size : Math.round(size * ar);
  const h = ar >= 1 ? Math.round(size / ar) : size;
  return (
    <svg
      width={w}
      height={h}
      viewBox={ic.viewBox}
      fill="currentColor"
      style={style}
      className={className}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ic.inner }}
    />
  );
}
