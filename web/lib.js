/* Pure comparison logic - no DOM, no pdf.js, no SheetJS.
   Kept separate from app.js so tools/test.mjs can exercise it under Node. */

/* ---------------------------------------------------------------- PDF rows */

/* Column header text -> record key. Standard pages have no Consignee column,
   Additional Charges pages do; reading the header row per page covers both. */
const COLUMN_KEYS = {
  'SNo.': 'sno',
  'Date': 'date',
  'AwbNo': 'awb',
  'Origin': 'origin',
  'Dest': 'dest',
  'Mode': 'mode',
  'Consignee': 'consignee',
  'PCS': 'pcs',
  'Weight': 'weight',
  'Amount': 'amount',
};

export const PDF_COLUMNS = [
  'invoice_no', 'section', 'page', 'sno', 'date', 'awb',
  'origin', 'dest', 'mode', 'pcs', 'weight', 'amount',
];

const SECTIONS = new Set(['Standard', 'Additional Charges']);
const AWB_RE = /^\d{10,14}$/;
const DMY_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/* Every cell of an invoice row shares one Y baseline, so grouping text items
   by Y reconstructs rows exactly. Tolerance guards against float drift; the
   row pitch is ~12.8pt, far larger than 1.0. */
function groupIntoLines(cells, tolerance = 1.0) {
  const sorted = cells.slice().sort((a, b) => b.y - a.y);
  const lines = [];
  let current = null;
  for (const cell of sorted) {
    if (!current || Math.abs(current.y - cell.y) > tolerance) {
      current = { y: cell.y, cells: [] };
      lines.push(current);
    }
    current.cells.push(cell);
  }
  for (const line of lines) line.cells.sort((a, b) => a.x - b.x);
  return lines;
}

/* Items always start at their column's x, so nearest-start-x is exact. */
function columnFor(x, columns) {
  let best = columns[0];
  let bestDist = Math.abs(columns[0].x - x);
  for (const col of columns) {
    const dist = Math.abs(col.x - x);
    if (dist < bestDist) { best = col; bestDist = dist; }
  }
  return best;
}

/**
 * Build invoice rows from per-page text cells.
 * @param {Array<Array<{x:number,y:number,str:string}>>} pages
 * @returns {{rows: Object[], invoices: Object[], period: {from: Date, to: Date}|null}}
 */
export function extractPdfRows(pages) {
  const rows = [];
  const invoices = [];
  let columns = null;   // carried forward: overflow pages have no header row
  let section = null;   // carried forward: a page's banner may sit on the page before
  let invoiceNo = null;

  pages.forEach((cells, index) => {
    const pageNo = index + 1;
    const lines = groupIntoLines(cells.filter((c) => c.str.trim() !== ''));
    let summary = null;

    for (const line of lines) {
      const texts = line.cells.map((c) => c.str.trim());
      const joined = texts.join(' ');

      if (joined.includes('Page No') && SECTIONS.has(texts[0])) section = texts[0];

      const banner = joined.match(/\|\s*([A-Z]{2,4}\/\d+\/[A-Z]\d+)/);
      if (banner) invoiceNo = banner[1];

      const labelled = readSummaryLine(texts);
      if (labelled) {
        if (labelled.key === 'invoice_no') invoiceNo = labelled.value;
        summary = summary || { page: pageNo };
        summary[labelled.key] = labelled.value;
      }

      if (texts.includes('AwbNo')) {
        columns = line.cells
          .filter((c) => COLUMN_KEYS[c.str.trim()])
          .map((c) => ({ x: c.x, key: COLUMN_KEYS[c.str.trim()] }));
        continue;
      }
      if (!columns) continue;

      const record = {};
      for (const cell of line.cells) {
        const key = columnFor(cell.x, columns).key;
        record[key] = (record[key] ? record[key] + ' ' : '') + cell.str.trim();
      }
      if (!AWB_RE.test(record.awb || '')) continue;

      rows.push({
        invoice_no: invoiceNo,
        section,
        page: pageNo,
        sno: record.sno || '',
        date: record.date || '',
        awb: record.awb,
        origin: record.origin || '',
        dest: record.dest || '',
        mode: record.mode || '',
        pcs: record.pcs || '',
        weight: record.weight || '',
        amount: record.amount || '',
      });
    }

    if (summary && summary.from_date && summary.to_date) invoices.push(summary);
  });

  return { rows, invoices, period: periodOf(invoices) };
}

/* Summary pages put the label and its value as two cells on the same Y line. */
const SUMMARY_LABELS = [
  [/^Invoice Date\s*:?$/, 'invoice_date'],
  [/^From Date\s*:?$/, 'from_date'],
  [/^Date To\s*:?$/, 'to_date'],
  [/^Invoice No\.?\s*:?$/, 'invoice_no'],
  [/^Invoice Amount\s*:?$/, 'invoice_amount'],
  [/^Total Invoice Value.*$/, 'total'],
];

function readSummaryLine(texts) {
  for (let i = 0; i < texts.length; i += 1) {
    for (const [pattern, key] of SUMMARY_LABELS) {
      if (pattern.test(texts[i]) && texts[i + 1]) return { key, value: texts[i + 1] };
    }
  }
  return null;
}

function periodOf(invoices) {
  const from = invoices.map((i) => parseDmy(i.from_date)).filter(Boolean);
  const to = invoices.map((i) => parseDmy(i.to_date)).filter(Boolean);
  if (!from.length || !to.length) return null;
  return {
    from: new Date(Math.min(...from.map((d) => d.getTime()))),
    to: new Date(Math.max(...to.map((d) => d.getTime()))),
  };
}

export function parseDmy(value) {
  const match = DMY_RE.exec((value || '').trim());
  if (!match) return null;
  return makeDate(+match[3], +match[2], +match[1]);
}

/* ------------------------------------------------------------------- dates */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function makeDate(year, month, day) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function fullYear(year) {
  if (year >= 1000) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

/**
 * Tolerant date reader. The sample register mixes `1-July-26` and `1-Aug-2026`
 * in one column, and .xlsx cells arrive as Date objects or serial numbers.
 * Slash dates are read day-first, matching the invoice's Indian format.
 */
export function parseLooseDate(value) {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : makeDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial: day 1 is 1900-01-01, with the historical leap-year bug.
    if (value < 1 || value > 60000) return null;
    const ms = Math.round((value - 25569) * 86400000);
    const date = new Date(ms);
    return makeDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  const text = String(value).trim();
  if (!text) return null;

  let m = /^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{2,4})$/.exec(text);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return month ? makeDate(fullYear(+m[3]), month, +m[1]) : null;
  }

  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (m) return makeDate(+m[1], +m[2], +m[3]);

  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text);
  if (m) return makeDate(fullYear(+m[3]), +m[2], +m[1]);

  return null;
}

export function formatDate(date) {
  if (!date) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
}

/* --------------------------------------------------------------- look-alike */

/* Only a one-character insertion/deletion counts as a look-alike. Transposition
   and single-digit substitution were measured against the real invoice and are
   worthless here: AWB stickers run sequentially, so near-neighbours are
   legitimately different shipments (396 and 124 false positives respectively). */
function deletionVariants(value) {
  const out = new Set();
  for (let i = 0; i < value.length; i += 1) out.add(value.slice(0, i) + value.slice(i + 1));
  return out;
}

export function findLookalikes(value, otherSet) {
  const hits = new Set();
  for (const variant of deletionVariants(value)) {
    if (otherSet.has(variant)) hits.add(variant);
  }
  for (const other of otherSet) {
    if (other.length === value.length + 1 && deletionVariants(other).has(value)) hits.add(other);
  }
  return [...hits];
}

/* ----------------------------------------------------------------- compare */

/**
 * @param {Object[]} pdfRows        from extractPdfRows
 * @param {Object[]} excelRows      {awb, date: Date|null, cells: string[], rowNumber}
 * @param {{from: Date, to: Date}|null} period
 * @param {boolean} useDateFilter
 */
export function compare(pdfRows, excelRows, period, useDateFilter) {
  const active = useDateFilter && period ? period : null;

  const included = [];
  const skipped = [];
  for (const row of excelRows) {
    // A row we cannot date is never dropped silently - always compare it.
    const outside = active && row.date
      && (row.date.getTime() < active.from.getTime() || row.date.getTime() > active.to.getTime());
    (outside ? skipped : included).push(row);
  }

  const pdfSet = new Set(pdfRows.map((r) => r.awb));
  const excelSet = new Set(included.map((r) => r.awb).filter(Boolean));

  const seen = new Map();
  for (const row of included) {
    if (row.awb) seen.set(row.awb, (seen.get(row.awb) || 0) + 1);
  }

  const matched = [];
  const excelOnly = [];
  for (const row of included) {
    const entry = { ...row, duplicate: (seen.get(row.awb) || 0) > 1 };
    if (row.awb && pdfSet.has(row.awb)) matched.push(entry);
    else excelOnly.push({ ...entry, lookalikes: findLookalikes(row.awb || '', pdfSet) });
  }

  const pdfOnly = pdfRows
    .filter((row) => !excelSet.has(row.awb))
    .map((row) => ({ ...row, lookalikes: findLookalikes(row.awb, excelSet) }));

  return {
    matched,
    excelOnly,
    pdfOnly,
    skipped,
    undated: included.filter((r) => !r.date).length,
    period: active,
  };
}

/* ---------------------------------------------------------------- coverage */

const NO_DATE = '—';

/**
 * Day-by-day accounting of what was billed against what was booked, so a large
 * "only in PDF" number explains itself instead of reading as an accusation.
 *
 * `matched` counts PDF rows whose AWB appears anywhere in the register, not
 * only on the same day. Keyed per-day it would total less than the headline
 * "matched" chip whenever something was booked one day and billed the next,
 * and the table would silently disagree with the summary. `dateShifted`
 * reports exactly that difference instead.
 *
 * @param {Object[]} pdfRows
 * @param {Object[]} excelRows  the in-period rows, i.e. what was compared
 */
export function coverage(pdfRows, excelRows) {
  const excelSet = new Set(excelRows.map((r) => r.awb).filter(Boolean));
  const byDate = new Map();
  const bucket = (date) => {
    if (!byDate.has(date)) byDate.set(date, { date, billed: 0, booked: 0, matched: 0, gap: 0 });
    return byDate.get(date);
  };

  for (const row of pdfRows) {
    const entry = bucket(row.date || NO_DATE);
    entry.billed += 1;
    if (excelSet.has(row.awb)) entry.matched += 1;
    else entry.gap += 1;
  }
  for (const row of excelRows) {
    bucket(row.date ? formatDate(row.date) : NO_DATE).booked += 1;
  }

  const rows = [...byDate.values()].sort((a, b) => {
    const da = parseDmy(a.date);
    const db = parseDmy(b.date);
    if (!da) return 1;          // undated rows sit at the bottom
    if (!db) return -1;
    return da.getTime() - db.getTime();
  });

  const totals = rows.reduce((acc, r) => ({
    billed: acc.billed + r.billed,
    booked: acc.booked + r.booked,
    matched: acc.matched + r.matched,
    gap: acc.gap + r.gap,
  }), { billed: 0, booked: 0, matched: 0, gap: 0 });

  // Booked one day, billed another - still a correct match, but it makes the
  // per-day BOOKED and MATCHED columns disagree, so surface the count.
  const pdfDateOf = new Map(pdfRows.map((r) => [r.awb, r.date]));
  const dateShifted = excelRows.filter((r) => r.date && pdfDateOf.has(r.awb)
    && pdfDateOf.get(r.awb) !== formatDate(r.date)).length;

  return {
    rows,
    totals,
    ratio: totals.billed ? totals.booked / totals.billed : 0,
    dateShifted,
  };
}

/* --------------------------------------------------------------------- csv */

export function toCsv(header, rows) {
  const cell = (value) => {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
}
