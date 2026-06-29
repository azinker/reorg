#!/usr/bin/env python3
"""Extract order + USPS tracking pairs from a batch label PDF (selectable text)."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import fitz
from openpyxl import Workbook

TRACKING_RE = re.compile(r"(?:USPS TRACKING #\s*)?(\d{4}(?: \d{4}){4} \d{2})")
ORDER_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("ebay", re.compile(r"^\d{2}-\d{5}-\d{5}$")),
    ("marketplace_long", re.compile(r"^\d{3}-\d{7}-\d{7}$")),
    ("hash", re.compile(r"^#\s*\d+$")),
    ("numeric", re.compile(r"^\d{4,10}$")),
]
HASH_EMBEDDED_RE = re.compile(r"#\s*(\d+)\s*$")


@dataclass
class LabelRow:
    page: int
    order_number: str
    tracking_number: str
    order_format: str
    recipient_line: str


def normalize_tracking(raw: str) -> str:
    return re.sub(r"\s+", "", raw.strip())


def classify_order(line: str) -> tuple[str, str] | None:
    candidate = line.strip()
    if not candidate:
        return None
    for fmt, pattern in ORDER_PATTERNS:
        if pattern.fullmatch(candidate):
            normalized = candidate
            if fmt == "hash":
                normalized = f"#{candidate.lstrip('#').strip()}"
            return normalized, fmt
    embedded = HASH_EMBEDDED_RE.search(candidate)
    if embedded:
        return f"#{embedded.group(1)}", "hash"
    return None


def extract_from_page_text(page_num: int, text: str) -> LabelRow | None:
    tracking_match = TRACKING_RE.search(text)
    if not tracking_match:
        return None
    tracking = normalize_tracking(tracking_match.group(1))

    lines = [ln.strip() for ln in text.splitlines()]
    # Anchor after service line; recipient name is next non-empty line.
    start_idx = None
    for i, line in enumerate(lines):
        if "USPS GROUND ADVANTAGE" in line.upper():
            start_idx = i + 1
            break
    if start_idx is None:
        return None

    recipient = ""
    order_number = ""
    order_format = ""
    for j in range(start_idx, min(start_idx + 6, len(lines))):
        line = lines[j]
        if not line or line.upper() == "SHIP":
            continue
        classified = classify_order(line)
        if classified:
            order_number, order_format = classified
            if j > start_idx:
                recipient = lines[j - 1]
            break
        if not recipient and line.upper() != "TO:":
            recipient = line

    if not order_number:
        return None

    return LabelRow(
        page=page_num,
        order_number=order_number,
        tracking_number=tracking,
        order_format=order_format,
        recipient_line=recipient,
    )


def extract_from_page_blocks(page_num: int, page: fitz.Page) -> LabelRow | None:
    """Second pass: use text block geometry — order line sits above address block."""
    text = page.get_text("text")
    primary = extract_from_page_text(page_num, text)
    if primary:
        return primary

    blocks = page.get_text("blocks")
    # blocks: (x0, y0, x1, y1, text, block_no, block_type)
    texts = [b[4].strip() for b in blocks if b[4].strip()]
    combined = "\n".join(texts)
    return extract_from_page_text(page_num, combined)


def extract_pdf(pdf_path: Path) -> tuple[list[LabelRow], list[dict]]:
    doc = fitz.open(pdf_path)
    rows: list[LabelRow] = []
    issues: list[dict] = []

    for idx in range(doc.page_count):
        page_num = idx + 1
        text_a = doc[idx].get_text("text")
        text_b = doc[idx].get_text("blocks")
        combined_b = "\n".join(b[4].strip() for b in text_b if b[4].strip())

        row_a = extract_from_page_text(page_num, text_a)
        row_b = extract_from_page_text(page_num, combined_b)

        if row_a and row_b:
            if (
                row_a.order_number != row_b.order_number
                or row_a.tracking_number != row_b.tracking_number
            ):
                issues.append(
                    {
                        "page": page_num,
                        "type": "pass_mismatch",
                        "pass1": row_a.__dict__,
                        "pass2": row_b.__dict__,
                    }
                )
            rows.append(row_a)
        elif row_a:
            rows.append(row_a)
        elif row_b:
            rows.append(row_b)
        else:
            issues.append({"page": page_num, "type": "unparsed", "preview": text_a[:500]})

    doc.close()
    return rows, issues


def write_xlsx(rows: list[LabelRow], out_path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Trackings"
    ws.append(["Order Number", "Tracking Number"])
    for row in rows:
        ws.append([row.order_number, row.tracking_number])
    wb.save(out_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Export USPS label PDF to order/tracking xlsx")
    parser.add_argument("pdf", type=Path, help="Input label PDF path")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output xlsx path (default: same dir as PDF, <stem>_trackings.xlsx)",
    )
    args = parser.parse_args()

    pdf_path = args.pdf.resolve()
    if not pdf_path.exists():
        print(f"PDF not found: {pdf_path}", file=sys.stderr)
        return 1

    out_path = args.output or pdf_path.with_name(f"{pdf_path.stem}_trackings.xlsx")

    rows, issues = extract_pdf(pdf_path)

    # Tracking sanity: USPS 22-digit, usually starts with 94
    for row in rows:
        if len(row.tracking_number) != 22 or not row.tracking_number.isdigit():
            issues.append(
                {
                    "page": row.page,
                    "type": "bad_tracking_length",
                    "tracking": row.tracking_number,
                    "order": row.order_number,
                }
            )

    write_xlsx(rows, out_path)

    summary = {
        "pdf": str(pdf_path),
        "pages": len(rows) + len([i for i in issues if i.get("type") == "unparsed"]),
        "extracted": len(rows),
        "issues": issues,
        "output": str(out_path),
        "format_counts": {},
    }
    for row in rows:
        summary["format_counts"][row.order_format] = (
            summary["format_counts"].get(row.order_format, 0) + 1
        )

    print(json.dumps({k: v for k, v in summary.items() if k != "issues"}, indent=2))
    if issues:
        print(f"ISSUES ({len(issues)}):", file=sys.stderr)
        for issue in issues[:20]:
            print(json.dumps(issue), file=sys.stderr)
        return 2

    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
