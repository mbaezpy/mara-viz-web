"""Fetch from a download reference CSV; check and build a manually tagged CSV."""

from __future__ import annotations

import argparse
import csv
from difflib import get_close_matches
import json
from pathlib import Path

if __package__:
    from . import topics_to_d3 as topics
    from .csv_io import read_csv
    from .paper_retrieve import (
        HERE, DEFAULT_INPUT, DEFAULT_CACHE, DEFAULT_PATCHES,
        load_records, retrieve, work_for, write_json,
    )
else:
    import topics_to_d3 as topics
    from csv_io import read_csv
    from paper_retrieve import (
        HERE, DEFAULT_INPUT, DEFAULT_CACHE, DEFAULT_PATCHES,
        load_records, retrieve, work_for, write_json,
    )


DEFAULT_TAGGED = HERE / "inputs/publications_tagged.csv"


def related_topics(topic_id, definitions):
    """Show nearby defined IDs for inspection, without choosing a correction."""
    parent = topic_id.rpartition(".")[0]
    if parent in definitions:
        candidates = [parent] + [tid for tid, info in definitions.items() if info.get("parent") == parent]
    else:
        candidates = get_close_matches(topic_id.upper(), list(definitions), n=3, cutoff=0.65)
    return [{"id": tid, "name": definitions[tid]["name"]} for tid in candidates]


def check(input_csv, topics_csv, cache_path, patches_path):
    rows = read_csv(input_csv, required=("DOI", "Title", "final_topics"))
    definitions = topics.load_topics(topics_csv)
    topic_ids = set(definitions)
    if not topic_ids:
        raise ValueError(f"{topics_csv}: no topic definitions found")
    # Validate patch JSON strictly here; a typo must not silently discard corrections.
    patches = json.loads(patches_path.read_text(encoding="utf-8"))
    if not isinstance(patches, dict):
        raise ValueError(f"{patches_path}: expected a JSON object")
    topics.resolve_work_overrides(patches, patches_path)
    includes = patches.get("include", [])
    for include in [includes] if isinstance(includes, str) else includes:
        included = json.loads((patches_path.parent / include).read_text(encoding="utf-8"))
        if not isinstance(included, dict) or not included.get("id"):
            raise ValueError(f"{include}: included work must have an ID")
    by_id, _ = topics.index_works(load_records(cache_path))
    topics.apply_included_works(by_id, patches, patches_path)
    topics.apply_work_patches(by_id, patches)
    by_id, by_doi = topics.index_works(by_id.values())
    report = {"input": str(input_csv), "topics_csv": str(topics_csv),
              "topic_names": {tid: info["name"] for tid, info in definitions.items()},
              "rows": len(rows), "tagged": 0,
              "excluded": [], "untagged": [], "unknown_topics": [],
              "missing_identifiers": [], "missing_metadata": [], "duplicates": []}
    seen = {}
    for line, row in enumerate(rows, 2):
        identifier = row["DOI"]
        detail = {"row": line, "identifier": identifier, "title": row["Title"],
                  "final_topics": row["final_topics"]}
        assigned = topics.parse_topic_list(row["final_topics"])
        if not identifier:
            report["missing_identifiers"].append(detail)
        key = topics.normalize_openalex_id(identifier) or topics.normalize_doi(identifier)
        if key and key in seen:
            report["duplicates"].append({**detail, "first_row": seen[key]})
        elif key:
            seen[key] = line
        if assigned == ["0"]:
            report["excluded"].append(detail)
            continue
        if not assigned:
            report["untagged"].append(detail)
        else:
            unknown = set(assigned) - topic_ids
            if unknown:
                report["unknown_topics"].append({
                    **detail, "topics": sorted(unknown),
                    "valid_topics": [tid for tid in assigned if tid in topic_ids],
                    "related_topics": {tid: related_topics(tid, definitions) for tid in sorted(unknown)},
                })
            else:
                report["tagged"] += 1
        if identifier and not work_for(identifier, by_id, by_doi):
            report["missing_metadata"].append({**detail, "tagged": bool(assigned)})
    return report


def print_check(report):
    print(f"Input: {report['input']}\nRows: {report['rows']}; tagged: {report['tagged']}; "
          f"excluded (0): {len(report['excluded'])}; awaiting manual topics: {len(report['untagged'])}")
    print(f"Topic definitions: {report['topics_csv']} ({len(report['topic_names'])} IDs)")
    labels = {"untagged": "Publications missing topics", "unknown_topics": "Unknown topics",
              "missing_identifiers": "Missing identifiers", "duplicates": "Duplicate identifiers",
              "missing_metadata": "Missing metadata"}
    for field, label in labels.items():
        print(f"{label}: {len(report[field])}")
        for item in report[field]:
            title = " ".join(item['title'].splitlines()) or "(untitled)"
            print(f"  CSV row {item['row']}: {title}")
            print(f"    DOI / OpenAlex ID: {item['identifier'] or '(missing identifier)'}")
            print(f"    final_topics: {item['final_topics']!r}")
            if field == "unknown_topics":
                for tid in item["topics"]:
                    print(f"    Unknown topic ID: {tid!r} is not defined in {report['topics_csv']}")
                    related = item["related_topics"][tid]
                    if related:
                        print("    Related defined topics (reference only):")
                        for candidate in related:
                            print(f"      {candidate['id']}: {candidate['name']}")
                if item["valid_topics"]:
                    valid = "; ".join(f"{tid}: {report['topic_names'][tid]}" for tid in item["valid_topics"])
                    print(f"    Recognized assignments: {valid}")
                print("    Action: correct final_topics, or define the intended new topic in the topic CSV.")
            elif field == "untagged":
                print("    Action: assign topic IDs manually; use 0 only to explicitly exclude this publication.")
            elif field == "missing_identifiers":
                print("    Action: fill in the DOI column with a DOI or OpenAlex work ID.")
            elif field == "duplicates":
                print(f"    Also appears at CSV row {item['first_row']}; assignments are merged during build.")
            elif field == "missing_metadata":
                print("    Action: run fetch with this input CSV, or supply the work through the patches file.")


def write_issues_csv(path, report):
    """Export validation details for inspection in a spreadsheet, even on failure."""
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, delimiter=";", fieldnames=[
            "severity", "issue", "row", "DOI", "Title", "final_topics", "details", "related_topics",
        ])
        writer.writeheader()
        for field in ("untagged", "unknown_topics", "missing_identifiers", "duplicates", "missing_metadata"):
            for item in report[field]:
                details = {"untagged": "No topic IDs assigned",
                           "missing_identifiers": "DOI / OpenAlex ID is empty",
                           "missing_metadata": "No cached or patched work matches this identifier"}.get(field, "")
                related = []
                if field == "unknown_topics":
                    details = "Unknown topic IDs: " + ", ".join(item["topics"])
                    related = list(dict.fromkeys(
                        f"{t['id']}: {t['name']}" for candidates in item["related_topics"].values() for t in candidates
                    ))
                elif field == "duplicates":
                    details = f"Same identifier as CSV row {item['first_row']}; assignments will be merged"
                warning = field == "duplicates" or (field == "missing_metadata" and not item["tagged"])
                writer.writerow({"severity": "warning" if warning else "error", "issue": field,
                                 "row": item["row"], "DOI": item["identifier"], "Title": item["title"],
                                 "final_topics": item["final_topics"], "details": details,
                                 "related_topics": " | ".join(related)})


def build(report, args, output_dir):
    errors = []
    for key in ("unknown_topics", "missing_identifiers"):
        if report[key]:
            label = "publication(s) with unknown topic IDs" if key == "unknown_topics" else "missing identifiers"
            errors.append(f"{len(report[key])} {label}")
    missing = [r for r in report["missing_metadata"] if r["tagged"]]
    if missing:
        errors.append(f"{len(missing)} tagged publications without metadata (run fetch)")
    if report["untagged"] and not args.allow_untagged:
        errors.append(f"{len(report['untagged'])} publications await manual topics; "
                      "complete final_topics or use --allow-untagged for a partial preview")
    if report["tagged"] == 0:
        errors.append("no tagged publications to build")
    if errors:
        raise ValueError("Cannot build: " + "; ".join(errors))
    # Import only after validation, so check/fetch don't need graph dependencies.
    if __package__:
        from .collab_network import run_pipeline
    else:
        from collab_network import run_pipeline
    output_dir.mkdir(parents=True, exist_ok=True)
    topics.build_outputs(
        topics_csv=args.topics_csv, publications_csv=args.input_csv,
        openalex_cache=args.cache, openalex_patch=args.patches,
        hierarchy_output=output_dir / "topics_hierarchy.json",
        lookup_output=output_dir / "topics_lookup.json", output_dir=output_dir,
        top_papers=topics.DEFAULT_TOP_PAPERS, top_keywords=topics.DEFAULT_TOP_KEYWORDS,
        top_journals=topics.DEFAULT_TOP_JOURNALS, top_authors=topics.DEFAULT_TOP_AUTHORS,
    )
    run_pipeline(lookup_json=output_dir / "topics_lookup.json", out_prefix=output_dir / "oa_coauth")
    print(f"Built web datasets in {output_dir}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "fetch", "build"))
    parser.add_argument("input_csv", type=Path, nargs="?",
                        help="Defaults to publications_2026.csv for fetch; publications_tagged.csv for check/build")
    parser.add_argument("--topics-csv", type=Path, default=HERE / "inputs/topics.csv")
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--patches", type=Path, default=DEFAULT_PATCHES)
    parser.add_argument("--output-dir", type=Path, help="Build destination; defaults to runs/<input>/data")
    parser.add_argument("--delay", type=float, default=0.2)
    parser.add_argument("--with-references", action="store_true", help="Also fetch cited works (optional)")
    parser.add_argument("--allow-untagged", action="store_true", help="Build only publications with manual topic tags")
    args = parser.parse_args(argv)
    args.input_csv = args.input_csv or (DEFAULT_INPUT if args.command == "fetch" else DEFAULT_TAGGED)
    run_dir = HERE / "runs" / args.input_csv.stem
    try:
        if args.command == "fetch":
            # The reference file only needs DOI identifiers. Topic annotations
            # belong to the separate manually maintained build input.
            print(f"Download reference: {args.input_csv}")
            retrieved = retrieve(args.input_csv, args.cache, args.patches, delay=args.delay,
                                 with_references=args.with_references,
                                 report_path=run_dir / "retrieval.json")
            print(f"Retrieval report: {run_dir / 'retrieval.json'}")
            return 1 if retrieved["failed"] else 0
        report = check(args.input_csv, args.topics_csv, args.cache, args.patches)
        write_json(run_dir / "status.json", report)
        write_issues_csv(run_dir / "validation_issues.csv", report)
        print_check(report)
        print(f"Detailed status: {run_dir / 'status.json'}")
        print(f"Validation issues CSV: {run_dir / 'validation_issues.csv'}")
        if args.command == "build":
            build(report, args, args.output_dir or run_dir / "data")
        if args.command == "check":
            return int(bool(report["unknown_topics"] or report["missing_identifiers"] or
                            report["untagged"] or report["missing_metadata"]))
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Error: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
