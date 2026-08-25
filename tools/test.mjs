/* Headless checks of the browser extractor and matching logic.
   Runs the same web/lib.js the page runs, through the same vendored pdf.js.

   Usage: node tools/test.mjs
*/
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import {
  extractPdfRows, parseLooseDate, compare, coverage, formatDate, toCsv,
} from '../web/lib.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => path.join(root, 'tests', 'fixtures', name);

let failures = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

/* ---------------------------------------------------------------- pdf side */

/* pdf.js reaches for a few browser globals at import time. Text extraction
   never touches them, so minimal stubs avoid pulling in @napi-rs/canvas. */
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init = [1, 0, 0, 1, 0, 0]) {
      const [a, b, c, d, e, f] = Array.isArray(init) ? init : [1, 0, 0, 1, 0, 0];
      Object.assign(this, { a, b, c, d, e, f });
    }
  };
}
if (typeof globalThis.ImageData === 'undefined') globalThis.ImageData = class ImageData {};
if (typeof globalThis.Path2D === 'undefined') globalThis.Path2D = class Path2D {};

const pdfjsLib = await import('../web/vendor/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc =
  pathToFileURL(path.join(root, 'web/vendor/pdf.worker.min.mjs')).href;

const doc = await pdfjsLib.getDocument({
  data: new Uint8Array(readFileSync(fixture('sample-invoice.pdf'))),
  useSystemFonts: false,
  isEvalSupported: false,
}).promise;

const pages = [];
for (let n = 1; n <= doc.numPages; n += 1) {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  pages.push(content.items
    .filter((i) => typeof i.str === 'string')
    .map((i) => ({ x: i.transform[4], y: i.transform[5], str: i.str })));
}

const { rows: pdfRows, invoices, period } = extractPdfRows(pages);

console.log('--- pdf extraction ---');
check('pages', doc.numPages, 7);
check('rows', pdfRows.length, 120);
check('unique awbs', new Set(pdfRows.map((r) => r.awb)).size, 120);
check('invoices found', invoices.length, 2);
check('period from', formatDate(period.from), '01/06/2026');
check('period to', formatDate(period.to), '30/06/2026');

/* The fixture generator knows the ground truth, so this diffs pdf.js output
   against what was actually written into the file, field by field. */
const expected = rowsToObjects(parseCsv(readFileSync(fixture('expected-rows.csv'), 'utf8')));
check('expected rows', expected.length, 120);

let diffs = 0;
const numeric = new Set(['sno', 'page', 'pcs', 'weight', 'amount']);
for (let i = 0; i < Math.max(pdfRows.length, expected.length); i += 1) {
  const a = pdfRows[i] || {};
  const b = expected[i] || {};
  for (const key of ['invoice_no', 'section', 'page', 'sno', 'date', 'awb',
    'origin', 'dest', 'mode', 'pcs', 'weight', 'amount']) {
    const av = numeric.has(key) ? Number(a[key]) : String(a[key] ?? '');
    const bv = numeric.has(key) ? Number(b[key]) : String(b[key] ?? '');
    if (av !== bv) {
      if (diffs < 10) console.log(`   DIFF row ${i} ${key}: ${JSON.stringify(a[key])} vs ${JSON.stringify(b[key])}`);
      diffs += 1;
    }
  }
}
check('field diffs vs generator ground truth', diffs, 0);

/* Structural quirks the fixture deliberately contains. */
check('back-billed rows sit outside the invoice period',
  pdfRows.filter((r) => r.section === 'Additional Charges').length, 5);
check('continuation page has rows despite no header row',
  pdfRows.filter((r) => r.page === 4).length, 20);
check('section carried from the banner on the previous page',
  pdfRows.filter((r) => r.page === 6).every((r) => r.section === 'Standard'), 'true');
check('second invoice detected on its own pages',
  new Set(pdfRows.filter((r) => r.page >= 6).map((r) => r.invoice_no)).size, 1);

/* -------------------------------------------------------------- excel side */

const XLSX = require('../web/vendor/xlsx.full.min.js');

/* Mirrors web/app.js: every sheet with an AWB column, matched up by header
   name, rate cards and summaries left alone. */
function readRegister(file, type) {
  const wb = XLSX.read(readFileSync(fixture(file)), { type, cellDates: true });
  const sheets = [];
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
    const at = grid.findIndex((r) => r.some((c) => /awb/i.test(String(c))));
    if (at < 0) continue;
    sheets.push({
      name,
      header: grid[at].map((c) => String(c).replace(/\s+/g, ' ').trim()),
      body: grid.slice(at + 1).filter((r) => r.some((c) => String(c).trim() !== '')),
      at,
    });
  }
  const header = [];
  for (const s of sheets) for (const h of s.header) if (!header.includes(h)) header.push(h);
  const awbCol = header.findIndex((c) => /awb/i.test(c));
  const dateCol = header.findIndex((c) => /date/i.test(c));

  const rows = [];
  for (const s of sheets) {
    const map = header.map((h) => s.header.indexOf(h));
    s.body.forEach((cells, i) => rows.push({
      sheet: s.name,
      rowNumber: s.at + 2 + i,
      awb: normaliseAwb(map[awbCol] < 0 ? '' : cells[map[awbCol]]),
      date: dateCol < 0 || map[dateCol] < 0 ? null : parseLooseDate(cells[map[dateCol]]),
      cells: map.map((c) => (c < 0 ? '' : display(cells[c]))),
    }));
  }
  return { header, awbCol, dateCol, rows, sheets: sheets.map((s) => s.name) };
}

console.log('\n--- excel parsing (csv) ---');
const csvReg = readRegister('sample-register.csv', 'buffer');
check('awb column detected', csvReg.header[csvReg.awbCol], 'AWB NO.');
check('date column detected', csvReg.header[csvReg.dateCol], 'DATE');
check('rows', csvReg.rows.length, 71);
check('one row has an unreadable date', csvReg.rows.filter((r) => !r.date).length, 1);

/* ---------------------------------------------------------------- compare */

console.log('\n--- compare ---');
const result = compare(pdfRows, csvReg.rows, period, true);
check('matched', result.matched.length, 41);
check('in excel not in pdf', result.excelOnly.length, 5);
check('in pdf not in excel', result.pdfOnly.length, 80);
check('skipped (outside the invoice period)', result.skipped.length, 25);
check('undated rows are compared, not dropped', result.undated, 1);
check('duplicate booking flagged', result.matched.filter((r) => r.duplicate).length, 2);

const flaggedExcel = result.excelOnly.filter((r) => r.lookalikes.length);
const flaggedPdf = result.pdfOnly.filter((r) => r.lookalikes.length);
check('excel rows flagged as look-alikes', flaggedExcel.length, 1);
check('pdf rows flagged as look-alikes', flaggedPdf.length, 1);
check('look-alike pair is one inserted digit',
  flaggedExcel[0].awb.length - flaggedExcel[0].lookalikes[0].length, 1);
check('look-alikes are never auto-matched',
  result.matched.some((r) => r.awb === flaggedExcel[0].awb), 'false');

const unfiltered = compare(pdfRows, csvReg.rows, period, false);
check('without the period filter, next-month rows surface',
  unfiltered.excelOnly.length, result.excelOnly.length + 25);
check('  ...and matching is unaffected', unfiltered.matched.length, result.matched.length);

/* --------------------------------------------------------------- coverage */

console.log('\n--- coverage ---');
const cov = coverage(pdfRows, result.matched.concat(result.excelOnly));
check('total billed', cov.totals.billed, 120);
check('total booked', cov.totals.booked, 46);
check('total matched', cov.totals.matched, 40);
check('gap reconciles with "only in PDF"', cov.totals.gap, result.pdfOnly.length);
check('billed column sums to the row count', cov.totals.billed, pdfRows.length);
check('register coverage', `${Math.round(cov.ratio * 100)}%`, '38%');
check('billed on a different day than booked', cov.dateShifted, 1);
check('rows are chronological', isChronological(cov.rows), 'true');
check('undated bookings get their own bucket',
  cov.rows.filter((r) => r.date === '—').length, 1);

/* ---------------------------------------------------- xlsx path, same data */

console.log('\n--- excel parsing (xlsx) ---');
const xlsxReg = readRegister('sample-register.xlsx', 'buffer');
check('rows', xlsxReg.rows.length, 71);
check('long awbs survive as digits, not scientific notation',
  xlsxReg.rows.filter((r) => /^\d{12,13}$/.test(r.awb)).length, 71);
const xlsxResult = compare(pdfRows, xlsxReg.rows, period, true);
check('matched agrees with the csv path', xlsxResult.matched.length, result.matched.length);
check('only-in-excel agrees with the csv path', xlsxResult.excelOnly.length, result.excelOnly.length);
check('only-in-pdf agrees with the csv path', xlsxResult.pdfOnly.length, result.pdfOnly.length);

/* ------------------------------------------------- a register split by month */

console.log('');
console.log('--- excel parsing (multi-sheet xlsx) ---');
const multi = readRegister('sample-register-multisheet.xlsx', 'buffer');
check('sheets with bookings are used', multi.sheets.join(', '), 'June, July');
check('the rate card is left alone', multi.sheets.includes('Rates'), 'false');
check('rows across both sheets', multi.rows.length, 71);
check('rows carry their sheet', new Set(multi.rows.map((r) => r.sheet)).size, 2);

/* The whole point: splitting a register across tabs must not change the answer. */
const multiResult = compare(pdfRows, multi.rows, period, true);
check('matched', multiResult.matched.length, result.matched.length);
check('in excel not in pdf', multiResult.excelOnly.length, result.excelOnly.length);
check('in pdf not in excel', multiResult.pdfOnly.length, result.pdfOnly.length);
check('skipped', multiResult.skipped.length, result.skipped.length);
check('same awbs, in the same order',
  multiResult.excelOnly.map((r) => r.awb).join(',') === result.excelOnly.map((r) => r.awb).join(','),
  'true');
const multiCov = coverage(pdfRows, multiResult.matched.concat(multiResult.excelOnly));
check('coverage is unchanged too',
  `${multiCov.totals.billed}/${multiCov.totals.booked}/${multiCov.totals.matched}/${multiCov.totals.gap}`,
  `${cov.totals.billed}/${cov.totals.booked}/${cov.totals.matched}/${cov.totals.gap}`);

/* ------------------------------------------------------------ small pieces */

console.log('\n--- date parsing ---');
check('4-June-26', formatDate(parseLooseDate('4-June-26')), '04/06/2026');
check('4-Jun-2026', formatDate(parseLooseDate('4-Jun-2026')), '04/06/2026');
check('15/07/2026 is read day-first', formatDate(parseLooseDate('15/07/2026')), '15/07/2026');
check('2026-07-15', formatDate(parseLooseDate('2026-07-15')), '15/07/2026');
check('excel serial 46204', formatDate(parseLooseDate(46204)), '01/07/2026');
check('unreadable value', parseLooseDate('n/a'), 'null');

console.log('\n--- csv export ---');
const exported = toCsv(['awb', 'dest'], [['900000000008', 'SURAT'], ['1', 'A, B "quoted"']]);
check('header', exported.split('\r\n')[0], 'awb,dest');
check('quoting', exported.split('\r\n')[2], '1,"A, B ""quoted"""');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

/* ----------------------------------------------------------------- helpers */

function normaliseAwb(value) {
  if (value == null) return '';
  if (typeof value === 'number') return String(Math.round(value));
  return String(value).trim();
}

function display(value) {
  if (value == null) return '';
  if (value instanceof Date) return formatDate(parseLooseDate(value));
  return String(value).trim();
}

function isChronological(rows) {
  const dated = rows.filter((r) => r.date !== '—').map((r) => {
    const [d, m, y] = r.date.split('/');
    return Date.UTC(+y, +m - 1, +d);
  });
  return dated.every((t, i) => i === 0 || dated[i - 1] <= t);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

function rowsToObjects(grid) {
  const [head, ...rest] = grid;
  return rest.map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i]])));
}
