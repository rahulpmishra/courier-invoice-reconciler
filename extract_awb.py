#!/usr/bin/env python3
"""Extract AWB (consignment) rows from a Trackon courier tax-invoice PDF.

Usage:
    python extract_awb.py <invoice.pdf> [more.pdf ...]

Writes <pdfname>.csv next to the PDF (and <pdfname>.xlsx if openpyxl is
installed), then prints a reconciliation of the summed row amounts against
each invoice's own "Invoice Amount" header.

Requires the `pdftotext` binary on PATH (Xpdf or poppler).

NOTE: -table mode is mandatory. With -layout, pdftotext renders the
Mode/Amount column half a line high, so those two values land on the previous
row's text line -- silently shifting every mode and amount by one row.
"""

import csv
import os
import re
import subprocess
import sys

FIELDS = [
    "invoice_no", "section", "page", "sno", "date", "awb",
    "origin", "dest", "mode", "pcs", "weight", "amount",
]

# SNo  Date  AwbNo  Origin  Dest  Mode  PCS  Weight  Amount
ROW_RE = re.compile(
    r"^\s*(\d+)\s+(\d{2}/\d{2}/\d{4})\s+(\d{10,14})\s+(\S+)\s+(.+?)"
    r"\s{2,}([SA])?\s*(\d+)\s+([\d.]+)\s+([\d,]*\.\d{2})\s*$",
    re.M,
)
# "D00000 - ACME LOGISTICS (...) | EXM/1000/A0001 | Fuel(%).18.00 | Dev(%). 5.00"
DETAIL_HDR_RE = re.compile(r"\|\s*([A-Z]{3}/\d+/[A-Z]\d+)")
# "Invoice No.:   EXM/1000/A0001"  (summary page)
INV_NO_RE = re.compile(r"Invoice No\.?\s*:\s*(\S+)")
# "Standard        Page No : 1"  (-table pads oddly: "Page    No  :  1")
SECTION_RE = re.compile(r"^\s*(.*?)\s{2,}Page\s+No\s*:\s*\d+\s*$", re.M)
SECTIONS = {"Standard", "Additional Charges", "Express", "Air", "Surface", "Cargo"}

SUMMARY_KEYS = [
    ("invoice_amount", r"Invoice Amount\s*:\s*([\d,]*\.?\d+)"),
    ("fuel_surcharge", r"Fuel Surcharges\s*:\s*([\d,]*\.?\d+)"),
    ("addl_surcharge", r"Additional Surcharges\s*:\s*([\d,]*\.?\d+)"),
    ("dev_charge", r"Development Charge\s*:\s*([\d,]*\.?\d+)"),
    ("discount", r"Discount\s*:\s*([\d,]*\.?\d+)"),
    ("taxable_value", r"Taxable value\s*([\d,]*\.?\d+)"),
    ("cgst", r"CGST\s*@\s*:\s*[\d.]+\s*%\s*([\d,]*\.?\d+)"),
    ("sgst", r"SGST\s*@\s*:\s*[\d.]+\s*%\s*([\d,]*\.?\d+)"),
    ("total", r"Total Invoice Value \(INR\)\s*([\d,]*\.?\d+)"),
    ("invoice_date", r"Invoice Date\s*:\s*(\d{2}/\d{2}/\d{4})"),
    ("from_date", r"From Date\s*:\s*(\d{2}/\d{2}/\d{4})"),
    ("to_date", r"Date To\s*:\s*(\d{2}/\d{2}/\d{4})"),
]


def num(s):
    return float(s.replace(",", ""))


def pdf_pages(path):
    """Return the PDF's pages as text, table-aligned, newline-normalised."""
    out = subprocess.run(
        ["pdftotext", "-table", path, "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if out.returncode != 0:
        raise SystemExit("pdftotext failed on %s:\n%s" % (path, out.stderr.strip()))
    return out.stdout.replace("\r", "").split("\f")


def parse(path):
    """Return (rows, summaries) for one invoice PDF."""
    rows, summaries = [], {}
    invoice_no = section = None

    for idx, page in enumerate(pdf_pages(path), start=1):
        # A summary page starts a new invoice and carries its totals.
        m = INV_NO_RE.search(page)
        if m:
            invoice_no = m.group(1)
            summary = {"invoice_no": invoice_no, "page": idx}
            for key, pat in SUMMARY_KEYS:
                mm = re.search(pat, page)
                summary[key] = mm.group(1).replace(",", "") if mm else None
            summaries[invoice_no] = summary

        # Detail pages repeat the invoice no in their "D00000 - ... | ..." banner.
        m = DETAIL_HDR_RE.search(page)
        if m:
            invoice_no = m.group(1)

        # The section banner may sit on the preceding page; carry it forward.
        for name in SECTION_RE.findall(page):
            if name in SECTIONS:
                section = name

        for g in ROW_RE.findall(page):
            rows.append({
                "invoice_no": invoice_no,
                "section": section,
                "page": idx,
                "sno": int(g[0]),
                "date": g[1],
                "awb": g[2],
                "origin": g[3],
                "dest": g[4].strip(),
                "mode": g[5] or "",
                "pcs": int(g[6]),
                "weight": float(g[7]),
                "amount": num(g[8]),
            })

    # Every 12-digit token in the document should belong to a parsed row.
    all_tokens = set(re.findall(r"\b\d{12}\b", "\f".join(pdf_pages(path))))
    missed = sorted(all_tokens - {r["awb"] for r in rows})
    return rows, summaries, missed


def write_csv(rows, out_path):
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)


def write_xlsx(rows, out_path):
    try:
        from openpyxl import Workbook
    except ImportError:
        return None
    wb = Workbook()
    ws = wb.active
    ws.title = "AWB"
    ws.append(FIELDS)
    for r in rows:
        ws.append([r[f] for f in FIELDS])
    ws.freeze_panes = "A2"
    wb.save(out_path)
    return out_path


def report(path, rows, summaries, missed):
    print("=" * 72)
    print(os.path.basename(path))
    print("=" * 72)

    awbs = [r["awb"] for r in rows]
    dupes = sorted({a for a in awbs if awbs.count(a) > 1})
    print("rows: %d   unique AWB: %d   duplicates: %s"
          % (len(rows), len(set(awbs)), ", ".join(dupes) or "none"))
    if missed:
        print("WARNING: %d 12-digit token(s) not captured as rows: %s"
              % (len(missed), ", ".join(missed[:10])))

    for inv, s in summaries.items():
        sub = [r for r in rows if r["invoice_no"] == inv]
        print("\n%s   %s -> %s   (invoiced %s)"
              % (inv, s["from_date"], s["to_date"], s["invoice_date"]))
        for sec in sorted({r["section"] for r in sub}, key=str):
            srows = [r for r in sub if r["section"] == sec]
            print("  %-20s n=%-5d pcs=%-5d wt=%9.3f  amount=%10.2f"
                  % (sec, len(srows), sum(r["pcs"] for r in srows),
                     sum(r["weight"] for r in srows),
                     sum(r["amount"] for r in srows)))
        got = round(sum(r["amount"] for r in sub), 2)
        want = num(s["invoice_amount"]) if s["invoice_amount"] else None
        if want is None:
            print("  %-20s rows=%10.2f  (no header amount to compare)" % ("RECONCILE", got))
        else:
            delta = round(got - want, 2)
            flag = "OK" if abs(delta) <= 0.05 else "MISMATCH"
            print("  %-20s rows=%10.2f  header=%10.2f  delta=%+.2f  %s"
                  % ("RECONCILE", got, want, delta, flag))
        print("  taxable=%s  cgst=%s  sgst=%s  total=%s"
              % (s["taxable_value"], s["cgst"], s["sgst"], s["total"]))
    print()


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__.strip())
    for path in argv[1:]:
        rows, summaries, missed = parse(path)
        stem = os.path.splitext(path)[0]
        write_csv(rows, stem + ".csv")
        xlsx = write_xlsx(rows, stem + ".xlsx")
        report(path, rows, summaries, missed)
        print("wrote %s" % (stem + ".csv"))
        print("wrote %s" % xlsx if xlsx else "openpyxl not installed - skipped .xlsx")


if __name__ == "__main__":
    main(sys.argv)
