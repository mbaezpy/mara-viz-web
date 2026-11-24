"""Resume OpenAlex retrieval into the shared cache without downloading cache hits."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

if __package__:
    from .csv_io import read_csv
    from .openalex_patcher import apply_included_works, load_patches
    from .topics_to_d3 import index_works, normalize_doi, normalize_openalex_id
else:
    from csv_io import read_csv
    from openalex_patcher import apply_included_works, load_patches
    from topics_to_d3 import index_works, normalize_doi, normalize_openalex_id

HERE = Path(__file__).resolve().parent
DEFAULT_INPUT = HERE / "inputs/publications_2026.csv"
DEFAULT_CACHE = HERE / "cache/openalex_cache.json"
DEFAULT_PATCHES = HERE / "patches/openalex_patches.json"


def write_json(path: Path, payload):
    """Replace a complete JSON file only after the new file is written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    temporary.replace(path)


def load_records(path: Path):
    if not path.exists():
        return []
    records = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(records, list) or any(not isinstance(w, dict) or not w.get("id") for w in records):
        raise ValueError(f"{path}: expected a list of OpenAlex works with IDs")
    return records


def work_for(identifier, by_id, by_doi):
    return by_id.get(normalize_openalex_id(identifier)) or by_doi.get(normalize_doi(identifier))


def make_session():
    session = requests.Session()
    retries = Retry(total=3, backoff_factor=0.5, status_forcelist=(429, 500, 502, 503, 504),
                    respect_retry_after_header=False)
    session.mount("https://", HTTPAdapter(max_retries=retries))
    key = os.environ.get("OPENALEX_API_KEY")
    if key:
        session.headers["Authorization"] = f"Bearer {key}"
    email = os.environ.get("OPENALEX_EMAIL")
    if email:
        session.params["mailto"] = email
    return session


def fetch_work(session, identifier):
    target = normalize_openalex_id(identifier) or f"https://doi.org/{normalize_doi(identifier)}"
    response = session.get(f"https://api.openalex.org/works/{target}", timeout=(10, 30))
    response.raise_for_status()
    work = response.json()
    if not isinstance(work, dict) or not work.get("id"):
        raise ValueError("OpenAlex response did not contain a work ID")
    return work


def retrieve(input_csv, cache_path=DEFAULT_CACHE, patches_path=DEFAULT_PATCHES,
             *, delay=0.2, with_references=False, session=None, report_path=None):
    if delay < 0:
        raise ValueError("delay must be non-negative")
    rows = read_csv(input_csv, required=("DOI",))
    records = load_records(cache_path)
    by_id, by_doi = index_works(records)
    # Included works are already supplied locally; do not fetch them again.
    apply_included_works(by_id, load_patches(patches_path), patches_path)
    by_id, by_doi = index_works(by_id.values())
    identifiers = list(dict.fromkeys(
        normalize_openalex_id(row["DOI"]) or normalize_doi(row["DOI"])
        for row in rows if row["DOI"].strip()
    ))
    report = {"input": str(input_csv), "requested": len(identifiers), "cached": 0,
              "downloaded": 0, "failed": [], "references_requested": with_references}
    pending = 0
    own_session = session is None
    session = session or make_session()

    def ensure(identifier):
        nonlocal pending
        existing = work_for(identifier, by_id, by_doi)
        if existing:
            report["cached"] += 1
            return existing
        try:
            work = fetch_work(session, identifier)
        except (requests.RequestException, ValueError) as exc:
            # Avoid logging request URLs, which might contain credentials.
            response = getattr(exc, "response", None)
            status = getattr(response, "status_code", None)
            error = f"HTTP {status}" if status else type(exc).__name__
            report["failed"].append({"identifier": identifier, "error": error})
            print(f"Could not retrieve {identifier}: {error}", flush=True)
            # Do not repeat requests when authentication or the API budget blocks us.
            if status in (401, 403, 429):
                raise RuntimeError(f"OpenAlex returned {error}; check OPENALEX_API_KEY and API budget") from None
            return None
        finally:
            time.sleep(delay)
        # A DOI alias can resolve to a work already stored under another identifier.
        if work["id"] not in by_id:
            records.append(work)
            pending += 1
            report["downloaded"] += 1
        work_id_index, work_doi_index = index_works([work])
        by_id.update(work_id_index)
        by_doi.update(work_doi_index)
        by_doi[normalize_doi(identifier)] = work
        if pending >= 10:
            write_json(cache_path, records)
            pending = 0
        print(f"Retrieved {identifier}", flush=True)
        return work

    try:
        references = set()
        for identifier in identifiers:
            work = ensure(identifier)
            if work and with_references:
                references.update(work.get("referenced_works") or [])
        for identifier in sorted(references):
            ensure(identifier)
    finally:
        if pending:
            write_json(cache_path, records)
        if report_path:
            write_json(report_path, report)
        if own_session:
            session.close()
    print(f"Cache hits: {report['cached']}; downloaded: {report['downloaded']}; failed: {len(report['failed'])}")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_csv", type=Path, nargs="?", default=DEFAULT_INPUT)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--patches", type=Path, default=DEFAULT_PATCHES)
    parser.add_argument("--delay", type=float, default=0.2)
    parser.add_argument("--with-references", action="store_true", help="Optional; the web network only needs input works")
    args = parser.parse_args(argv)
    report = retrieve(args.input_csv, args.cache, args.patches, delay=args.delay,
                      with_references=args.with_references,
                      report_path=HERE / "runs" / args.input_csv.stem / "retrieval.json")
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
