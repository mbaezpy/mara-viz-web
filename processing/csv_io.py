"""Read publication spreadsheets exported as UTF-8 or Windows CSV files."""

import csv
import io
from pathlib import Path


def read_csv(path: Path, required=()):
    raw = Path(path).read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1252")
    # Count separators in the header, rather than guessing from DOI/title text.
    header = text.splitlines()[0] if text.splitlines() else ""
    delimiter = max((";", ",", "\t"), key=header.count)
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    missing = set(required) - set(reader.fieldnames or [])
    if missing:
        raise ValueError(f"{path}: missing column(s): {', '.join(sorted(missing))}")
    rows = []
    for line, row in enumerate(reader, 2):
        if None in row:
            raise ValueError(f"{path}: row {line} has extra fields; check CSV quoting")
        rows.append({key: (value or "").strip() for key, value in row.items()})
    return rows
