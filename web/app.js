import * as pdfjsLib from './vendor/pdf.min.mjs';
import {
  extractPdfRows, parseLooseDate, formatDate, compare, coverage, toCsv, PDF_COLUMNS,
} from './lib.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);

const state = {
  pdf: null,     // { rows, invoices, period, name }
  excel: null,   // { header, rows, name, awbCol, dateCol }
  result: null,
  filters: { excel: '', pdf: '', matched: '' },
};

/* ------------------------------------------------------------ file pickers */

const load = {
  pdf: wireDrop('pdfDrop', 'pdfInput', 'pdfHint', loadPdf),
  excel: wireDrop('xlsDrop', 'xlsInput', 'xlsHint', loadExcel),
};

function wireDrop(dropId, inputId, hintId, handler) {
  const drop = $(dropId);
  const input = $(inputId);

  input.addEventListener('change', () => {
    if (input.files[0]) run(input.files[0]);
  });

  ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (e) => {
    e.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) run(file);
  });

  async function run(file) {
    $(hintId).textContent = `Reading ${file.name}…`;
    drop.classList.remove('loaded');
    try {
      const summary = await handler(file);
      drop.classList.add('loaded');
      $(hintId).textContent = summary;
      setStatus('');
    } catch (err) {
      drop.classList.remove('loaded');
      $(hintId).textContent = 'Tap to choose, or drop a file here';
      setStatus(`${file.name}: ${err.message}`, true);
    }
    refreshControls();
  }

  return run;
}

/* --------------------------------------------------------------- samples */

/* The hosted demo ships a synthetic invoice and register, because a visitor
   who has never seen a courier invoice has nothing to try the page with.
   Served from samples/, which only the Pages deploy creates - so the button
   stays hidden anywhere the folder is absent. */
const SAMPLES = [
  ['samples/sample-invoice.pdf', 'application/pdf', 'pdf'],
  ['samples/sample-register.csv', 'text/csv', 'excel'],
];

fetch(SAMPLES[0][0], { method: 'HEAD' })
  .then((res) => { $('sampleRow').hidden = !res.ok; })
  .catch(() => {});

$('sampleBtn').addEventListener('click', async () => {
  const btn = $('sampleBtn');
  btn.disabled = true;
  try {
    for (const [url, type, which] of SAMPLES) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const name = url.split('/').pop();
      await load[which](new File([await res.blob()], name, { type }));
    }
    $('runBtn').click();
  } catch (err) {
    setStatus(`Could not load the sample files: ${err.message}`, true);
  }
  btn.disabled = false;
});

/* ------------------------------------------------------------------ pdf in */

async function loadPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;

  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    setStatus(`Reading PDF page ${n} of ${doc.numPages}…`);
    // eslint-disable-next-line no-await-in-loop
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items
      .filter((i) => typeof i.str === 'string')
      .map((i) => ({ x: i.transform[4], y: i.transform[5], str: i.str })));
  }

  const parsed = extractPdfRows(pages);
  if (!parsed.rows.length) {
    throw new Error('no invoice rows found - is this a Trackon consignment invoice?');
  }
  state.pdf = { ...parsed, name: file.name };

  const invoiceNos = [...new Set(parsed.rows.map((r) => r.invoice_no).filter(Boolean))];
  return `${parsed.rows.length} rows · ${doc.numPages} pages`
    + (invoiceNos.length ? ` · ${invoiceNos.join(', ')}` : '');
}

/* ---------------------------------------------------------------- excel in */

async function loadExcel(file) {
  const book = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new Error('the workbook has no sheets');

  // Two views of the same grid: raw values drive the logic (no scientific
  // notation on long AWB numbers), formatted values drive what is displayed.
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  const fmt = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  const headerIndex = raw.findIndex((row) => row.some((c) => /awb/i.test(String(c))));
  const useHeader = headerIndex >= 0 ? headerIndex : 0;
  const header = (raw[useHeader] || []).map((c) => String(c).replace(/\s+/g, ' ').trim());
  if (!header.length) throw new Error('the first sheet looks empty');

  const rows = [];
  for (let i = useHeader + 1; i < raw.length; i += 1) {
    const rawRow = raw[i] || [];
    const fmtRow = fmt[i] || [];
    if (!rawRow.some((c) => String(c).trim() !== '')) continue;
    rows.push({
      rowNumber: i + 1,
      raw: rawRow,
      cells: header.map((_, c) => display(fmtRow[c] ?? rawRow[c])),
    });
  }

  state.excel = {
    name: file.name, header, rows, sheetName: book.SheetNames[0],
    awbCol: header.findIndex((c) => /awb/i.test(c)),
    dateCol: header.findIndex((c) => /date/i.test(c)),
  };
  applyColumnChoice();

  return `${rows.length} rows · sheet "${book.SheetNames[0]}"`;
}

function display(value) {
  if (value == null) return '';
  if (value instanceof Date) return formatDate(parseLooseDate(value));
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  return String(value).trim();
}

function normaliseAwb(value) {
  if (value == null) return '';
  if (typeof value === 'number') return String(Math.round(value));
  return String(value).trim();
}

/* Derive awb/date per row from the chosen columns. */
function applyColumnChoice() {
  const { rows, awbCol, dateCol } = state.excel;
  for (const row of rows) {
    row.awb = awbCol >= 0 ? normaliseAwb(row.raw[awbCol]) : '';
    row.date = dateCol >= 0 ? parseLooseDate(row.raw[dateCol]) : null;
  }
}

/* --------------------------------------------------------------- controls */

function refreshControls() {
  const ready = Boolean(state.pdf && state.excel);
  $('optionsCard').hidden = !(state.pdf || state.excel);
  $('runBtn').disabled = !ready;

  const period = state.pdf?.period;
  $('periodLabel').innerHTML = period
    ? `Invoice period <strong>${formatDate(period.from)} – ${formatDate(period.to)}</strong>`
      + '<small>Excel rows outside these dates are ignored.</small>'
    : 'No invoice period found in the PDF<small>Every Excel row will be compared.</small>';

  const needsPicker = state.excel && (state.excel.awbCol < 0 || state.excel.dateCol < 0);
  $('columnPicker').hidden = !needsPicker;
  if (needsPicker) buildColumnPicker();
}

function buildColumnPicker() {
  const { header, awbCol, dateCol } = state.excel;
  for (const [id, chosen, onPick] of [
    ['awbCol', awbCol, (v) => { state.excel.awbCol = v; }],
    ['dateCol', dateCol, (v) => { state.excel.dateCol = v; }],
  ]) {
    const select = $(id);
    select.innerHTML = '';
    if (id === 'dateCol') select.append(new Option('(none)', '-1'));
    header.forEach((name, i) => select.append(new Option(name || `Column ${i + 1}`, String(i))));
    select.value = String(chosen);
    select.onchange = () => { onPick(Number(select.value)); applyColumnChoice(); };
  }
}

$('runBtn').addEventListener('click', () => {
  try {
    setStatus('Comparing…');
    // Excel rows outside the invoice period are dropped outright - they are
    // never counted, listed or exported.
    state.result = compare(state.pdf.rows, state.excel.rows, state.pdf.period, true);
    render();
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  }
});

for (const [id, key] of [['excelSearch', 'excel'], ['pdfSearch', 'pdf'],
  ['matchedSearch', 'matched']]) {
  $(id).addEventListener('input', (e) => {
    state.filters[key] = e.target.value.trim().toLowerCase();
    render();
  });
}

document.querySelectorAll('[data-download]').forEach((btn) => {
  btn.addEventListener('click', () => downloadCsv(btn.dataset.download));
});

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

/* ----------------------------------------------------------------- render */

function render() {
  const r = state.result;
  if (!r) return;

  $('summaryCard').hidden = false;
  $('chips').innerHTML = [
    chip('good', `${r.matched.length} matched`),
    chip('bad', `${r.excelOnly.length} only in Excel`),
    chip('bad', `${r.pdfOnly.length} only in PDF`),
    r.undated ? chip('warn', `${r.undated} with an unreadable date`) : '',
  ].join('');

  const notes = [];
  notes.push(r.period
    ? `Only Excel rows dated ${formatDate(r.period.from)} – ${formatDate(r.period.to)} were compared.`
    : 'Every Excel row was compared.');
  if (r.undated) notes.push('Rows whose date could not be read are compared rather than dropped.');
  $('summaryNote').textContent = notes.join(' ');

  renderCoverage(coverage(state.pdf.rows, r.matched.concat(r.excelOnly)));
  renderExcelTable('excelCard', 'excelTable', 'excelCount', r.excelOnly, state.filters.excel, true);
  renderPdfTable('pdfCard', 'pdfTable', 'pdfCount', r.pdfOnly, state.filters.pdf, true);
  renderExcelTable('matchedCard', 'matchedTable', 'matchedCount', r.matched, state.filters.matched, false);
}

/* Explains where a large "only in PDF" number comes from: a per-day ledger of
   billed vs booked, plus a warning when the register plainly does not cover the
   invoice. Without this, the gap reads as over-billing rather than as rows the
   register never recorded. */
function renderCoverage(cov) {
  $('coverageCard').hidden = false;
  $('coverageDays').textContent = String(cov.rows.length);

  const banner = $('coverageBanner');
  const percent = Math.round(cov.ratio * 100);
  banner.hidden = cov.ratio >= 0.8;
  if (!banner.hidden) {
    banner.innerHTML = `Your register covers <strong>${percent}%</strong> of this invoice`
      + ` — ${cov.totals.booked} bookings recorded against ${cov.totals.billed} billed.`
      + ` Most of the ${cov.totals.gap} “only in PDF” rows below are shipments missing`
      + ' from your register, not proof of over-billing.';
  }

  const cols = [['billed', 'Billed'], ['booked', 'Booked'], ['matched', 'Matched'], ['gap', 'Gap']];
  const head = `<thead><tr><th>Date</th>${
    cols.map(([, label]) => `<th class="num">${label}</th>`).join('')
  }</tr></thead>`;
  const body = cov.rows.map((row) => `<tr><td>${escape(row.date)}</td>${
    cols.map(([key]) => `<td class="num">${row[key] || ''}</td>`).join('')
  }</tr>`).join('');
  const total = `<tr class="total"><td>Total</td>${
    cols.map(([key]) => `<td class="num">${cov.totals[key]}</td>`).join('')
  }</tr>`;

  $('coverageTable').innerHTML = `${head}<tbody>${body}${total}</tbody>`;
  const note = ['Gap = billed by Trackon but not found in your register.'];
  if (cov.dateShifted) {
    const n = cov.dateShifted;
    note.push(`${n} AWB${n === 1 ? ' was' : 's were'} billed on a different date than you`
      + ' booked them, so Booked and Matched can differ on a given day.'
      + ' They still count as matched.');
  }
  $('coverageNote').textContent = note.join(' ');
}

function chip(kind, text) {
  return `<span class="chip ${kind}">${escape(text)}</span>`;
}

function matches(row, needle) {
  if (!needle) return true;
  return (row.cells || PDF_COLUMNS.map((k) => row[k]))
    .some((c) => String(c ?? '').toLowerCase().includes(needle));
}

function renderExcelTable(cardId, tableId, countId, rows, needle, showBadges) {
  const card = $(cardId);
  card.hidden = false;
  const shown = rows.filter((r) => matches(r, needle));
  $(countId).textContent = String(rows.length);

  const header = state.excel.header;
  const head = `<thead><tr><th class="key">AWB</th><th>Row</th>${
    header.map((h, i) => (i === state.excel.awbCol ? '' : `<th>${escape(h || `Col ${i + 1}`)}</th>`)).join('')
  }</tr></thead>`;

  const body = shown.map((row) => {
    const badges = showBadges ? badgeHtml(row) : (row.duplicate ? '<span class="tag dup">dup</span>' : '');
    return `<tr><td class="key">${escape(row.awb || '—')}${badges}</td>`
      + `<td class="num">${row.rowNumber}</td>`
      + header.map((_, i) => (i === state.excel.awbCol ? '' : `<td>${escape(row.cells[i] ?? '')}</td>`)).join('')
      + '</tr>';
  }).join('');

  $(tableId).innerHTML = head + `<tbody>${body}</tbody>`;
  emptyState(tableId, shown.length, rows.length, needle);
}

function renderPdfTable(cardId, tableId, countId, rows, needle, showBadges) {
  const card = $(cardId);
  card.hidden = false;
  const shown = rows.filter((r) => matches(r, needle));
  $(countId).textContent = String(rows.length);

  const cols = PDF_COLUMNS.filter((c) => c !== 'awb');
  const head = `<thead><tr><th class="key">AWB</th>${
    cols.map((c) => `<th>${escape(labelFor(c))}</th>`).join('')
  }</tr></thead>`;

  const numeric = new Set(['page', 'sno', 'pcs', 'weight', 'amount']);
  const body = shown.map((row) => `<tr><td class="key">${escape(row.awb)}${
    showBadges ? badgeHtml(row) : ''
  }</td>${
    cols.map((c) => `<td${numeric.has(c) ? ' class="num"' : ''}>${escape(row[c] ?? '')}</td>`).join('')
  }</tr>`).join('');

  $(tableId).innerHTML = head + `<tbody>${body}</tbody>`;
  emptyState(tableId, shown.length, rows.length, needle);
}

function badgeHtml(row) {
  let out = '';
  if (row.duplicate) out += '<span class="tag dup">dup</span>';
  if (row.lookalikes?.length) {
    out += `<span class="tag" title="Possible typo">≈ ${escape(row.lookalikes.join(', '))}</span>`;
  }
  return out;
}

function emptyState(tableId, shown, total, needle) {
  const scroller = $(tableId).parentElement;
  scroller.querySelector('.empty')?.remove();
  if (shown) return;
  const message = total === 0
    ? 'Nothing here — both sides agree.'
    : `No rows match "${needle}".`;
  scroller.insertAdjacentHTML('beforeend', `<p class="empty">${escape(message)}</p>`);
}

const LABELS = {
  invoice_no: 'Invoice', section: 'Section', page: 'Page', sno: 'S.No', date: 'Date',
  origin: 'Origin', dest: 'Destination', mode: 'Mode', pcs: 'PCS',
  weight: 'Weight', amount: 'Amount',
};
const labelFor = (key) => LABELS[key] || key;

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* -------------------------------------------------------------- downloads */

function downloadCsv(which) {
  const r = state.result;
  if (!r) return;
  const stamp = (state.pdf?.name || 'invoice').replace(/\.pdf$/i, '');
  let header;
  let rows;
  let name;

  if (which === 'pdf') {
    header = PDF_COLUMNS;
    rows = r.pdfOnly.map((row) => PDF_COLUMNS.map((c) => row[c]));
    name = `${stamp}__in-pdf-not-in-excel.csv`;
  } else {
    const set = { excel: r.excelOnly, matched: r.matched }[which];
    header = ['excel_row', ...state.excel.header, 'possible_typo_of'];
    rows = set.map((row) => [row.rowNumber, ...row.cells, (row.lookalikes || []).join(' ')]);
    name = `${stamp}__${{ excel: 'in-excel-not-in-pdf', matched: 'matched' }[which]}.csv`;
  }

  const blob = new Blob(['﻿' + toCsv(header, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Marks a successful module load - tools/browser-check.html waits on this. */
document.documentElement.dataset.appReady = "1";
