"""Refresh OpenAlex citation statistics for input CSVs without rewriting metadata."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import unicodedata
from urllib.parse import quote

import requests

if __package__:
    from .csv_io import read_csv
    from .openalex_patcher import (
        apply_included_works, apply_work_patches, load_patches,
        load_citation_stats, validate_citation_stats,
    )
    from .paper_retrieve import (
        HERE, DEFAULT_CACHE, DEFAULT_PATCHES, load_records, make_session, work_for, write_json,
    )
    from .topics_to_d3 import index_works, normalize_doi, normalize_openalex_id, parse_topic_list
else:
    from csv_io import read_csv
    from openalex_patcher import (
        apply_included_works, apply_work_patches, load_patches,
        load_citation_stats, validate_citation_stats,
    )
    from paper_retrieve import (
        HERE, DEFAULT_CACHE, DEFAULT_PATCHES, load_records, make_session, work_for, write_json,
    )
    from topics_to_d3 import index_works, normalize_doi, normalize_openalex_id, parse_topic_list

DEFAULT_INPUT = HERE / "inputs/publications_tagged.csv"
DEFAULT_OUTPUT = HERE / "patches/openalex_stats.json"
DEFAULT_REPORT = HERE / "runs/update_stats/report.json"
SELECT = "id,doi,display_name,publication_year,cited_by_count,counts_by_year,updated_date"


class StatisticsError(ValueError):
    """A safe, actionable validation message containing no request credentials."""


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalized_title(value):
    return ''.join(c for c in unicodedata.normalize("NFKD", value or "").casefold() if c.isalnum())


def stats_fields(work, refreshed_at):
    # Do not default absent counts to zero: incomplete API responses must not erase data.
    fields = {
        "cited_by_count": work.get("cited_by_count"),
        "counts_by_year": work.get("counts_by_year"),
        "citation_stats_refreshed_at": refreshed_at,
        "citation_stats_source_updated_at": work.get("updated_date"),
        "citation_stats_source_work_id": normalize_openalex_id(work.get("id")),
    }
    validate_citation_stats(fields["citation_stats_source_work_id"], fields)
    return fields


def update_stats(input_csvs, cache_path=DEFAULT_CACHE, patches_path=DEFAULT_PATCHES,
                 output_path=DEFAULT_OUTPUT, *, report_path=DEFAULT_REPORT,
                 batch_size=100, delay=0.2, session=None):
    if not 1 <= batch_size <= 100 or delay < 0:
        raise ValueError("batch_size must be 1..100 and delay must be non-negative")
    input_csvs = [Path(path) for path in input_csvs]
    if not input_csvs:
        raise ValueError("At least one input CSV is required")
    snapshot = (load_citation_stats(output_path) if output_path.exists()
                else {"schema_version": 1, "works": {}})
    by_id, by_doi = index_works(load_records(cache_path))
    raw_counts = {wid: w.get("cited_by_count") for wid, w in by_id.items()}
    raw_identities = {wid: (normalized_title(w.get("display_name")), w.get("publication_year"))
                      for wid, w in by_id.items()}
    patches = load_patches(patches_path)
    apply_included_works(by_id, patches, patches_path)
    apply_work_patches(by_id, patches)
    by_id, by_doi = index_works(by_id.values())
    report = {"started_at": utc_now(), "inputs": [str(p) for p in input_csvs],
              "output": str(output_path), "requested": 0, "refreshed": 0,
              "excluded_rows": 0, "failed": [], "changes": [], "complete": False}
    targets = {}
    for path in input_csvs:
        for line, row in enumerate(read_csv(path, required=("DOI",)), 2):
            if parse_topic_list(row.get("final_topics", "")) == ["0"]:
                report["excluded_rows"] += 1
                continue
            identifier = row["DOI"]
            work = work_for(identifier, by_id, by_doi)
            detail = {"input": str(path), "row": line, "identifier": identifier,
                      "title": row.get("Title", "")}
            if not work:
                report["failed"].append({**detail, "error": "missing_metadata; run fetch first"})
                continue
            targets.setdefault(work["id"], {"work": work, "input_rows": []})["input_rows"].append(detail)
    report["requested"] = len(targets)
    pending = set(targets)
    own_session = session is None
    session = session or make_session()

    def request(url, params):
        try:
            response = session.get(url, params=params, timeout=(10, 30))
            response.raise_for_status()
            return response.json()
        finally:
            if delay:
                time.sleep(delay)

    def save():
        snapshot["source"] = "https://api.openalex.org/works"
        snapshot["updated_at"] = utc_now()
        write_json(output_path, snapshot)
        report["finished_at"] = utc_now()
        report["not_attempted"] = sorted(pending)
        report["complete"] = not pending and not report["failed"]
        if report_path:
            write_json(report_path, report)

    def fail(wid, error):
        report["failed"].append({"work_id": wid, "title": targets[wid]["work"].get("display_name"),
                                 "input_rows": targets[wid]["input_rows"], "error": error})
        pending.discard(wid)

    def accept(wid, remote):
        try:
            fields = stats_fields(remote, utc_now())
        except ValueError as exc:
            raise StatisticsError(str(exc)) from None
        cached = targets[wid]["work"]
        identity_resolution = "same_openalex_id"
        if fields["citation_stats_source_work_id"] != wid:
            # Singleton redirects may follow a merged OpenAlex ID. Only reuse its
            # counts when the DOI agrees; never replace the local reviewed identity.
            doi = normalize_doi(cached.get("doi"))
            identity_resolution = "merged_id_same_doi"
            if not doi or doi != normalize_doi(remote.get("doi")):
                # A merged article may legitimately have several DOIs. Confirm
                # that our original DOI resolves to exactly the same canonical work.
                alias = None
                if doi:
                    try:
                        alias = request(f"https://api.openalex.org/works/https://doi.org/{quote(doi, safe='/')}", {"select": "id"})
                    except requests.HTTPError as exc:
                        if getattr(exc.response, "status_code", None) != 404:
                            raise
                if alias is not None:
                    if not isinstance(alias, dict) or normalize_openalex_id(alias.get("id")) != fields["citation_stats_source_work_id"]:
                        raise StatisticsError("Merged work identity mismatch: original DOI resolves to a different record")
                    identity_resolution = "merged_id_verified_doi_alias"
                else:
                    # Retired DOIs can disappear from the API entirely. The original
                    # ID must redirect, and both the exact normalized title and year
                    # must agree. We never search for a work just by a similar title.
                    identities = [raw_identities.get(wid, (None, None)),
                                  (normalized_title(cached.get("display_name")), cached.get("publication_year"))]
                    if not any(title and title == normalized_title(remote.get("display_name"))
                               and type(year) is int and year == remote.get("publication_year")
                               for title, year in identities):
                        raise StatisticsError("Merged work identity mismatch: original DOI unavailable and title/year do not agree")
                    identity_resolution = "merged_id_verified_title_and_year"
        previous = snapshot["works"].get(wid, {}).get("cited_by_count", cached.get("cited_by_count"))
        snapshot["works"][wid] = fields
        report["changes"].append({"work_id": wid, "title": cached.get("display_name"),
            "doi": cached.get("doi"), "input_rows": targets[wid]["input_rows"],
            "cached_citations": raw_counts.get(wid), "previous_citations": previous,
            "current_citations": fields["cited_by_count"],
            "source_work_id": fields["citation_stats_source_work_id"],
            "source_doi": remote.get("doi"), "identity_resolution": identity_resolution,
            "delta": fields["cited_by_count"] - previous if type(previous) is int else None,
            "refreshed_at": fields["citation_stats_refreshed_at"]})
        report["refreshed"] += 1
        pending.discard(wid)

    def request_error(exc, ids):
        status = getattr(getattr(exc, "response", None), "status_code", None)
        # No URLs or exception messages: credentials may be present in request URLs.
        error = (f"HTTP {status}" if status else str(exc) if isinstance(exc, StatisticsError)
                 else type(exc).__name__)
        for wid in ids:
            fail(wid, error)
        if status in (401, 403, 429):
            raise RuntimeError(f"OpenAlex returned {error}; check OPENALEX_API_KEY and API budget") from None

    try:
        ids = list(targets)
        for offset in range(0, len(ids), batch_size):
            batch = ids[offset:offset + batch_size]
            try:
                payload = request("https://api.openalex.org/works", {
                    "filter": "ids.openalex:" + "|".join(wid.rsplit("/", 1)[-1] for wid in batch),
                    "per_page": 100, "select": SELECT,
                })
                if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
                    raise ValueError("Invalid OpenAlex batch response")
                results = {normalize_openalex_id(w.get("id")): w for w in payload["results"] if isinstance(w, dict)}
            except (requests.RequestException, ValueError) as exc:
                request_error(exc, batch)
                save()
                continue
            for wid in batch:
                try:
                    remote = results.get(wid)
                    if remote is None:
                        # Missing/merged IDs need singleton resolution; never silently skip them.
                        remote = request(f"https://api.openalex.org/works/{wid.rsplit('/', 1)[-1]}", {"select": SELECT})
                    if not isinstance(remote, dict):
                        raise ValueError("Invalid OpenAlex work response")
                    accept(wid, remote)
                except (requests.RequestException, ValueError) as exc:
                    request_error(exc, [wid])
            save()
            print(f"Citation stats: {report['refreshed']}/{len(targets)} refreshed; {len(report['failed'])} failed", flush=True)
    finally:
        save()
        if own_session:
            session.close()
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_csvs", type=Path, nargs="*", help="Defaults to inputs/publications_tagged.csv; accepts multiple CSVs")
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--patches", type=Path, default=DEFAULT_PATCHES)
    parser.add_argument("--output", type=Path, help="Snapshot destination; defaults to the configured stats_file")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--delay", type=float, default=0.2)
    args = parser.parse_args(argv)
    try:
        config = json.loads(args.patches.read_text(encoding="utf-8"))
        output = args.output or (args.patches.parent / config["stats_file"] if config.get("stats_file") else DEFAULT_OUTPUT)
        report = update_stats(args.input_csvs or [DEFAULT_INPUT], args.cache, args.patches, output,
                              report_path=args.report, batch_size=args.batch_size, delay=args.delay)
        print(f"Snapshot: {output}\nDetails: {args.report}")
        for item in report["failed"]:
            print(f"  {item.get('work_id') or item.get('identifier')}: {item.get('title')} — {item['error']}")
        return 0 if report["complete"] else 1
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Error: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
