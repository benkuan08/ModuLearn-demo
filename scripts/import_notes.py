"""Refresh the bundled source text from the selected COMP4431 lecture PDFs."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from pypdf import PdfReader

parser = argparse.ArgumentParser()
parser.add_argument('notes', type=Path)
parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'sources.json')
args = parser.parse_args()
lectures, pages = [], []
for file in args.notes.glob('*.pdf'):
    match = re.search(r'(?:Week\s*|_L)(\d+)', file.name, re.I)
    if not match:
        raise ValueError(f'Cannot identify lecture week: {file.name}')
    week = int(match.group(1))
    reader = PdfReader(file)
    lectures.append(dict(week=week, filename=file.name, pages=len(reader.pages), sha256=hashlib.sha256(file.read_bytes()).hexdigest()))
    for number, page in enumerate(reader.pages, 1):
        pages.append(dict(id=f'W{week:02d}-P{number:03d}', week=week, page=number, filename=file.name, text=page.extract_text() or ''))
assert len({p['id'] for p in pages}) == len(pages), 'Duplicate lecture week/page identifiers'
payload = dict(lectures=sorted(lectures, key=lambda x: x['week']), pages=sorted(pages, key=lambda x: (x['week'], x['page'])), limitations=['PDF text extraction does not recover information contained only in diagrams. Verify ambiguous formulas or figures against the original notes.'])
args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Imported {len(lectures)} PDFs, {len(pages)} pages into {args.output.name}')
