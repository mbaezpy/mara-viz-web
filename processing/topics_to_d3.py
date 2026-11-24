"""Build a D3-ready topic hierarchy and companion lookup tables.

This script ingests:
* topics with optional parent relationships
* publications tagged with topic identifiers
* OpenAlex metadata cache for the tagged publications

It outputs:
* a hierarchical JSON structure aggregating per-topic statistics for D3
* a lookup JSON file with curated papers, authors, and journals
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple
if __package__:
    from .csv_io import read_csv
    from .openalex_patcher import (
        load_patches, apply_included_works, apply_work_patches,
        apply_author_patches, get_author_local_overrides, resolve_work_overrides,
    )
else:
    from csv_io import read_csv
    from openalex_patcher import (
        load_patches, apply_included_works, apply_work_patches,
        apply_author_patches, get_author_local_overrides, resolve_work_overrides,
    )


DEFAULT_TOP_PAPERS = 5
DEFAULT_TOP_KEYWORDS = 10
DEFAULT_TOP_JOURNALS = 5
DEFAULT_TOP_AUTHORS = 5

LOCAL_AFFILIATIONS = [
    #"https://openalex.org/I4210104779",
    #"https://openalex.org/I4210131029",
    "https://openalex.org/I4387154539",
    #"https://ror.org/0162saw54",
    "Bethel Epilepsy Center",
    "Bethel Epilepsy Centre",
    "Epilepsy Center Bethel",
    "Epilepsy-Center Bethel",
    "Epilepsy Centre Bethel",
    "Epilepsy Center, Bethel",
    "Epilepsy Center, Bielefeld",
    "Epilepsy Center Bielefeld",
    "Zentrum für Epilepsie, Bielefeld",
    "Epilepsiezentrum Bethel",
    "Center of Epilepsy, Bielefeld",
    "Society for Epilepsy Research, Bielefeld",
    "Mara Epilepsy Center",
    "Mara Epilepsy Centre",
    "Epilepsy Centre Mara",
    "Epilepsy Center Mara",
    "Mara Epilepsiezentrum",
    "Klinik Mara",
    "Mara Clinic",
    "Clinic Mara",
    "Krankenhaus Mara",
    "Mara Hospital",
    #"Evangelisches Krankenhaus Bielefeld",
    #"Gesellschaft für Epilepsieforschung",
    #"Bodelschwing Foundation Bethel",
    #"Bodelschwinghsche Stiftungen Bethel",
]


def normalize_doi(doi: str) -> str:
    """Normalize DOI strings for consistent lookups."""
    if not doi:
        return ""
    # Excel exports can leave a mojibake non-breaking space (Â + NBSP).
    value = doi.strip().removesuffix("\u00c2").strip().lower()
    prefixes = (
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi:",
    )
    for prefix in prefixes:
        if value.startswith(prefix):
            value = value[len(prefix) :]
            break
    return value.strip()


def normalize_openalex_id(identifier: str) -> str:
    """Normalize OpenAlex work identifiers for consistent lookups.

    Accepts either a full URL (https://openalex.org/W123) or a bare ID (W123).
    Returns a normalized full URL or an empty string if the value does not look
    like an OpenAlex work identifier.
    """
    match = re.fullmatch(r"(?:https?://openalex\.org/)?(W[0-9]+)",
                         (identifier or "").strip(), flags=re.IGNORECASE)
    return f"https://openalex.org/{match[1].upper()}" if match else ""


def load_openalex_cache(path: Path) -> Tuple[Dict[str, dict], Dict[str, dict]]:
    """Return work lookups by OpenAlex ID and normalized DOI."""
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    return index_works(data)


def index_works(data: Iterable[dict]) -> Tuple[Dict[str, dict], Dict[str, dict]]:
    """Index cached or patched records using the same identifier rules."""
    works_by_id: Dict[str, dict] = {}
    works_by_doi: Dict[str, dict] = {}

    for entry in data:
        work_id = entry.get("id")
        if not work_id:
            continue
        works_by_id[work_id] = entry

        doi_candidates: Set[str] = set()
        doi_raw = entry.get("doi")
        if doi_raw:
            doi_candidates.add(normalize_doi(doi_raw))
        ids = entry.get("ids") or {}
        if isinstance(ids, dict):
            doi_from_ids = ids.get("doi")
            if doi_from_ids:
                doi_candidates.add(normalize_doi(doi_from_ids))

        for doi in filter(None, doi_candidates):
            works_by_doi[doi] = entry

    return works_by_id, works_by_doi


def ensure_topic(topics: Dict[str, dict], topic_id: str) -> dict:
    """Create topic stub if needed."""
    return topics.setdefault(
        topic_id,
        {
            "id": topic_id,
            "name": f"Topic {topic_id}",
            "parent": None,
            "children": [],
            "order": len(topics),
        },
    )


def load_topics(path: Path, delimiter: str = ";") -> Dict[str, dict]:
    """Load topic definitions and parent-child relationships."""
    topics: Dict[str, dict] = {}
    order = 0
    for row in read_csv(path, required=("topic_id", "topic_name", "parent_topic")):
        topic_id = (row.get("topic_id") or "").strip()
        if not topic_id:
            continue
        node = ensure_topic(topics, topic_id)
        node["name"] = (row.get("topic_name") or node["name"]).strip() or node["name"]

        parent = (row.get("parent_topic") or "").strip() or None
        node["parent"] = parent
        node["order"] = order
        order += 1

        if parent:
            ensure_topic(topics, parent)

    # rebuild children according to recorded order
    for info in topics.values():
        info["children"] = []
    for topic_id, info in topics.items():
        parent = info.get("parent")
        if parent and parent in topics:
            topics[parent]["children"].append(topic_id)
    for info in topics.values():
        info["children"].sort(key=lambda tid: topics[tid]["order"])
    return topics


def parse_topic_list(raw_topics: str) -> List[str]:
    """Split the topics string into a clean list of topic IDs."""
    if not raw_topics:
        return []
    items = []
    for value in raw_topics.split(","):
        topic = value.strip()
        if topic:
            items.append(topic)
    return items


def extract_source(work: dict) -> Optional[dict]:
    """Best-effort extraction of the journal/source metadata."""
    primary = work.get("primary_location") or {}
    source = primary.get("source")
    if isinstance(source, dict) and source.get("id"):
        return source
    host_venue = work.get("host_venue") or {}
    if isinstance(host_venue, dict) and host_venue.get("id"):
        return host_venue
    return None


LOCAL_AFFILIATION_ID_SET = {
    value.strip().lower()
    for value in LOCAL_AFFILIATIONS
    if value and value.strip().lower().startswith(("http://", "https://"))
}

LOCAL_AFFILIATION_NAME_FRAGMENTS = [
    value.strip().casefold()
    for value in LOCAL_AFFILIATIONS
    if value and not value.strip().lower().startswith(("http://", "https://"))
]


def _normalize_identifier(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def _normalize_text(value: Optional[str]) -> str:
    return (value or "").strip().casefold()


def is_local_affiliation(
    identifier: Optional[str] = None,
    name: Optional[str] = None,
    ror: Optional[str] = None,
    raw: Optional[str] = None,
) -> bool:
    """Determine whether an affiliation matches the configured local list."""
    for candidate in (identifier, ror):
        if candidate and _normalize_identifier(candidate) in LOCAL_AFFILIATION_ID_SET:
            return True
    text_candidates = [name, raw]
    for candidate in text_candidates:
        normalized = _normalize_text(candidate)
        if not normalized:
            continue
        for fragment in LOCAL_AFFILIATION_NAME_FRAGMENTS:
            if fragment and fragment in normalized:
                return True
    return False


def authorship_is_local(authorship: dict, raw_enabled: bool = True) -> bool:
    """Check whether any affiliation in the authorship is local."""
    for institution in authorship.get("institutions") or []:
        if is_local_affiliation(
            identifier=institution.get("id"),
            name=institution.get("display_name"),
            ror=institution.get("ror"),
        ):
            return True
    if raw_enabled:
        for raw_affiliation in authorship.get("raw_affiliation_strings") or []:
            if is_local_affiliation(raw=raw_affiliation):
                return True
    return False


def primary_affiliation_from_authorship(authorship: dict, raw_enabled: bool = True) -> Optional[dict]:
    """Return the primary affiliation record for an authorship (preferring local matches)."""
    institutions = authorship.get("institutions") or []
    fallback: Optional[dict] = None
    for institution in institutions:
        info = {
            "id": institution.get("id"),
            "display_name": institution.get("display_name"),
            "ror": institution.get("ror"),
        }
        if is_local_affiliation(
            identifier=info.get("id"), name=info.get("display_name"), ror=info.get("ror")
        ):
            return info
        if fallback is None and (info.get("id") or info.get("display_name")):
            fallback = info

    raw_affiliations = authorship.get("raw_affiliation_strings") or []
    if raw_enabled:
        for raw in raw_affiliations:
            normalized_raw = (raw or "").strip()
            if not normalized_raw:
                continue
            info = {"id": None, "display_name": normalized_raw, "ror": None}
            if is_local_affiliation(raw=normalized_raw):
                return info
            if fallback is None:
                fallback = info

    return fallback


def affiliation_is_local(affiliation: Optional[dict]) -> bool:
    if not affiliation:
        return False
    return is_local_affiliation(
        identifier=affiliation.get("id"),
        name=affiliation.get("display_name"),
        ror=affiliation.get("ror"),
    )



def aggregate_topic_assignments(
    publications_csv: Path,
    topics: Dict[str, dict],
    works_by_id: Dict[str, dict],
    works_by_doi: Dict[str, dict],
    delimiter: str = ";",
) -> Tuple[Dict[str, Set[str]], Dict[str, Set[str]], Set[str], List[dict]]:
    """Assign publications to topics, returning mappings per topic and per work."""
    topic_to_papers: Dict[str, Set[str]] = {tid: set() for tid in topics}
    paper_to_topics: Dict[str, Set[str]] = defaultdict(set)
    curated_work_ids: Set[str] = set()
    unmatched_rows: List[dict] = []

    for row in read_csv(publications_csv, required=("DOI", "Title", "final_topics")):
        raw_identifier = (row.get("DOI") or "").strip()
        title = (row.get("Title") or "").strip()
        topics_for_pub = parse_topic_list(row.get("final_topics", ""))
        if not topics_for_pub:
            continue

        work: Optional[dict] = None

        # 1) Try DOI lookup.
        doi = normalize_doi(raw_identifier)
        if doi:
            work = works_by_doi.get(doi)

        # 2) If not found by DOI, try OpenAlex ID (URL or bare ID).
        if work is None:
            openalex_id = normalize_openalex_id(raw_identifier)
            if openalex_id:
                work = works_by_id.get(openalex_id)

        if not work:
            unmatched_rows.append(
                {
                    "identifier": raw_identifier,
                    "title": title,
                    "topics": topics_for_pub,
                }
            )
            continue

        work_id = work.get("id")
        if not work_id:
            continue

        valid_topics = [tid for tid in topics_for_pub if tid in topics]
        if not valid_topics:
            continue

        curated_work_ids.add(work_id)
        for tid in valid_topics:
            topic_to_papers.setdefault(tid, set()).add(work_id)
            paper_to_topics[work_id].add(tid)

    return topic_to_papers, paper_to_topics, curated_work_ids, unmatched_rows


def propagate_topic_papers(
    topics: Dict[str, dict],
    direct_assignments: Dict[str, Set[str]],
) -> Dict[str, Set[str]]:
    """Collect papers for each topic including descendants."""
    aggregated: Dict[str, Set[str]] = {}

    def gather(tid: str) -> Set[str]:
        papers = set(direct_assignments.get(tid, set()))
        for child in topics[tid]["children"]:
            papers.update(gather(child))
        aggregated[tid] = papers
        return papers

    root_topics = [
        tid for tid, info in topics.items() if not info.get("parent")
    ]
    root_topics.sort(key=lambda tid: topics[tid]["order"])

    for tid in root_topics:
        gather(tid)
    return aggregated


def select_top_papers(works: Sequence[dict], limit: int) -> List[dict]:
    """Return the top papers sorted by citations then year."""
    if limit <= 0:
        return []

    def key_func(work: dict) -> Tuple[int, int, str]:
        cited = work.get("cited_by_count")
        year = work.get("publication_year")
        title = work.get("display_name") or work.get("title") or ""
        return (-(cited if isinstance(cited, int) else 0), -(year if isinstance(year, int) else 0), title)

    sorted_works = sorted(works, key=key_func)
    top_items = []
    for work in sorted_works[:limit]:
        doi = normalize_doi(work.get("doi", "") or (work.get("ids") or {}).get("doi", ""))
        top_items.append(
            {
                "id": work.get("id"),
                "title": work.get("display_name") or work.get("title"),
                "doi": doi or None,
                "cited_by_count": work.get("cited_by_count"),
                "publication_year": work.get("publication_year"),
            }
        )
    return top_items


def select_top_keywords(works: Sequence[dict], limit: int) -> List[dict]:
    """Return top keywords across works by cumulative score."""
    if limit <= 0:
        return []
    keyword_data: Dict[str, dict] = {}
    for work in works:
        for keyword in work.get("keywords") or []:
            kid = keyword.get("id") or keyword.get("display_name")
            if not kid:
                continue
            entry = keyword_data.setdefault(
                kid,
                {
                    "id": keyword.get("id") or kid,
                    "display_name": keyword.get("display_name") or kid,
                    "score": 0.0,
                    "count": 0,
                },
            )
            score = keyword.get("score")
            entry["score"] += float(score) if score is not None else 1.0
            entry["count"] += 1
    ranked = sorted(
        keyword_data.values(),
        key=lambda item: (-item["score"], -item["count"], item["display_name"]),
    )
    return ranked[:limit]


def select_top_journals(works: Sequence[dict], limit: int) -> List[dict]:
    """Return top journals by paper count."""
    if limit <= 0:
        return []
    journal_counts: Dict[str, dict] = {}
    for work in works:
        source = extract_source(work)
        if not source or not source.get("id"):
            continue
        journal_id = source["id"]
        entry = journal_counts.setdefault(
            journal_id,
            {
                "id": journal_id,
                "display_name": source.get("display_name"),
                "paper_count": 0,
            },
        )
        entry["paper_count"] += 1
    ranked = sorted(
        journal_counts.values(),
        key=lambda item: (-item["paper_count"], item["display_name"] or ""),
    )
    return ranked[:limit]


def select_top_authors(
    works: Sequence[dict],
    limit: int,
    authors_lookup: Dict[str, dict],
) -> List[dict]:
    """Return top authors by unique paper contributions (restricted to currently local authors)."""
    if limit <= 0:
        return []
    author_counts: Dict[str, dict] = {}
    for work in works:
        seen: Set[str] = set()
        for authorship in work.get("authorships") or []:
            author = authorship.get("author") or {}
            author_id = author.get("id")
            if not author_id or author_id in seen:
                continue
            lookup_entry = authors_lookup.get(author_id) or {}
            if not lookup_entry.get("currently_local"):
                continue
            seen.add(author_id)
            entry = author_counts.setdefault(
                author_id,
                {
                    "id": author_id,
                    "display_name": lookup_entry.get("display_name") or author.get("display_name"),
                    "orcid": lookup_entry.get("orcid") or author.get("orcid"),
                    "paper_count": 0,
                },
            )
            entry["paper_count"] += 1
    ranked = sorted(
        author_counts.values(),
        key=lambda item: (-item["paper_count"], item["display_name"] or ""),
    )
    return ranked[:limit]


def collect_years_from_works(work_ids: Iterable[str], works_by_id: Dict[str, dict]) -> List[int]:
    """Return sorted list of publication years for the provided works."""
    years: Set[int] = set()
    for wid in work_ids:
        year = (works_by_id.get(wid) or {}).get("publication_year")
        if isinstance(year, int):
            years.add(year)
    return sorted(years)


def _year_index(years: Sequence[int]) -> Dict[int, int]:
    """Map year -> index for quick lookup."""
    return {year: idx for idx, year in enumerate(years)}


def _counts_by_year(
    work_ids: Iterable[str],
    works_by_id: Dict[str, dict],
    year_to_index: Dict[int, int],
    length: int,
) -> List[int]:
    """Return list of counts aligned with the global years array."""
    counts = [0] * length
    for wid in work_ids:
        year = (works_by_id.get(wid) or {}).get("publication_year")
        if not isinstance(year, int):
            continue
        idx = year_to_index.get(year)
        if idx is None:
            continue
        counts[idx] += 1
    return counts


def _cumulative_from(counts: Sequence[int]) -> List[int]:
    """Return cumulative totals from each index to the end."""
    cumulative = [0] * len(counts)
    running = 0
    for idx in range(len(counts) - 1, -1, -1):
        running += counts[idx]
        cumulative[idx] = running
    return cumulative


def compute_topic_metrics(
    topics: Dict[str, dict],
    aggregated_papers: Dict[str, Set[str]],
    direct_assignments: Dict[str, Set[str]],
    works_by_id: Dict[str, dict],
    authors_lookup: Dict[str, dict],
    top_papers: int,
    top_keywords: int,
    top_journals: int,
    top_authors: int,
    years: Sequence[int],
) -> Dict[str, dict]:
    """Generate per-topic metrics and rankings."""
    metrics: Dict[str, dict] = {}
    year_to_index = _year_index(years)
    years_length = len(years)

    for topic_id, paper_ids in aggregated_papers.items():
        works = [works_by_id[wid] for wid in paper_ids if wid in works_by_id]
        yearly_doc_counts = _counts_by_year(paper_ids, works_by_id, year_to_index, years_length)
        yearly_direct_counts = _counts_by_year(
            direct_assignments.get(topic_id, set()), works_by_id, year_to_index, years_length
        )
        metrics[topic_id] = {
            "topic_id": topic_id,
            "doc_count": len(works),
            "doc_count_direct": len(direct_assignments.get(topic_id, set())),
            "top_papers": select_top_papers(works, top_papers),
            "top_keywords": select_top_keywords(works, top_keywords),
            "top_journals": select_top_journals(works, top_journals),
            "top_authors": select_top_authors(works, top_authors, authors_lookup),
            "yearly": {
                "doc_count": yearly_doc_counts,
                "doc_count_direct": yearly_direct_counts,
            },
            "cumulative_since": {
                "doc_count": _cumulative_from(yearly_doc_counts),
                "doc_count_direct": _cumulative_from(yearly_direct_counts),
                "size": _cumulative_from(yearly_doc_counts),
            },
        }
    return metrics


def build_d3_hierarchy(
    topics: Dict[str, dict],
    metrics: Dict[str, dict],
    curated_work_ids: Iterable[str],
    years: Sequence[int],
    works_by_id: Dict[str, dict],
    root_name: str = "Research Topics",
) -> dict:
    """Compose the nested D3 structure."""
    year_to_index = _year_index(years)

    def yearly_payload_from_metrics(stats: dict) -> dict:
        yearly = stats.get("yearly") or {}
        cumulative = stats.get("cumulative_since") or {}
        return {
            "yearly": {
                "doc_count": yearly.get("doc_count") or [],
                "doc_count_direct": yearly.get("doc_count_direct") or [],
            },
            "cumulative_since": {
                "doc_count": cumulative.get("doc_count") or [],
                "doc_count_direct": cumulative.get("doc_count_direct") or [],
                "size": cumulative.get("size") or (cumulative.get("doc_count") or []),
            },
        }

    def to_node(topic_id: str) -> dict:
        info = topics[topic_id]
        stats = metrics.get(topic_id, {})
        children = [to_node(child) for child in info["children"]]
        sample_title = ""
        top_papers = stats.get("top_papers") or []
        if top_papers:
            sample_title = top_papers[0].get("title") or ""
        return {
            "name": info["name"],
            "topic_id": topic_id,
            "size": stats.get("doc_count", 0),
            "doc_count": stats.get("doc_count", 0),
            "doc_count_direct": stats.get("doc_count_direct", 0),
            "sample": sample_title,
            "top_papers": top_papers,
            "top_keywords": stats.get("top_keywords") or [],
            "top_journals": stats.get("top_journals") or [],
            "top_authors": stats.get("top_authors") or [],
            "children": children,
            **yearly_payload_from_metrics(stats),
        }

    root_children = [
        tid for tid, info in topics.items() if not info.get("parent")
    ]
    root_children.sort(key=lambda tid: topics[tid]["order"])
    curated_set = set(curated_work_ids)
    yearly_counts_root = _counts_by_year(curated_set, works_by_id, year_to_index, len(years))
    cumulative_root = _cumulative_from(yearly_counts_root)
    root_node = {
        "name": root_name,
        "topic_id": "",
        "size": len(curated_set),
        "doc_count": len(curated_set),
        "children": [to_node(tid) for tid in root_children],
        "yearly": {
            "doc_count": yearly_counts_root,
            "doc_count_direct": yearly_counts_root,
        },
        "cumulative_since": {
            "doc_count": cumulative_root,
            "doc_count_direct": cumulative_root,
            "size": cumulative_root,
        },
    }
    return {"years": list(years), "root": root_node}


def build_lookup_tables(
    curated_work_ids: Iterable[str],
    works_by_id: Dict[str, dict],
    paper_to_topics: Dict[str, Set[str]],
    disable_raw_for: Set[str],
    author_overrides: Optional[Dict[str, dict]] = None,
) -> Tuple[Dict[str, dict], Dict[str, dict], Dict[str, dict]]:
    """Create lookup dictionaries for papers, authors, and journals."""
    papers_lookup: Dict[str, dict] = {}
    authors_lookup: Dict[str, dict] = {}
    journals_lookup: Dict[str, dict] = {}
    author_overrides = author_overrides or {}


    for work_id in curated_work_ids:
        work = works_by_id.get(work_id)
        if not work:
            continue
        doi = normalize_doi(work.get("doi", "") or (work.get("ids") or {}).get("doi", ""))

        work_raw_enabled = work_id not in disable_raw_for

        author_refs: List[dict] = []
        publication_year = work.get("publication_year")
        authorships = list(work.get("authorships") or [])
        total_authors = len(authorships)
        def resolve_forced_local(author_id: Optional[str]) -> Optional[bool]:
            if not author_id:
                return None
            override = author_overrides.get(author_id)
            local_cfg = override.get("force_local_authorships") if isinstance(override, dict) else None
            if not isinstance(local_cfg, dict):
                return None
            local_flag = local_cfg.get("local")
            if not isinstance(local_flag, bool):
                return None
            since = local_cfg.get("since_year")
            until = local_cfg.get("until_year")
            if isinstance(publication_year, int):
                if isinstance(since, int) and publication_year < since:
                    return None
                if isinstance(until, int) and publication_year > until:
                    return None
            else:
                if isinstance(since, int) or isinstance(until, int):
                    return None
            return local_flag

        for index, authorship in enumerate(authorships):
            author = authorship.get("author") or {}
            author_id = author.get("id")
            if not author_id:
                continue
            is_local = authorship_is_local(authorship,  raw_enabled=work_raw_enabled)
            forced_local = resolve_forced_local(author_id)
            if forced_local is not None:
                is_local = forced_local
            position = authorship.get("author_position") or ""
            explicit_main = authorship.get("main_author")
            if isinstance(explicit_main, bool):
                is_main_author = explicit_main
            else:
                is_main_author = position in {"first", "last"}
                if not is_main_author and total_authors >= 2:
                    is_main_author = index == 0 or index == total_authors - 1
            author_ref = {"id": author_id, "local": bool(is_local), "main_author": bool(is_main_author)}
            if isinstance(explicit_main, bool):
                author_ref["author_position"] = position
                for field in ("authorship_roles", "is_byline_author", "byline_position"):
                    if field in authorship:
                        author_ref[field] = authorship[field]
            author_refs.append(author_ref)
            entry = authors_lookup.setdefault(
                author_id,
                {
                    "id": author_id,
                    "display_name": author.get("display_name"),
                    "orcid": author.get("orcid"),
                    "paper_ids": set(),
                    "_latest_publication_year": None,
                    "current_affiliation": None,
                    "currently_local": False,
                    "has_local_authorship": False,
                },
            )
            if not entry.get("display_name") and author.get("display_name"):
                entry["display_name"] = author.get("display_name")
            if not entry.get("orcid") and author.get("orcid"):
                entry["orcid"] = author.get("orcid")
            entry["paper_ids"].add(work_id)
            if is_local:
                entry["has_local_authorship"] = True

            current_latest = entry.get("_latest_publication_year")
            primary_affiliation = primary_affiliation_from_authorship(authorship, raw_enabled=work_raw_enabled)
            affiliation_local = affiliation_is_local(primary_affiliation) or is_local

            should_update_affiliation = False
            if isinstance(publication_year, int):
                if current_latest is None or not isinstance(current_latest, int) or publication_year > current_latest:
                    should_update_affiliation = True
                elif publication_year == current_latest and not entry.get("currently_local") and affiliation_local:
                    should_update_affiliation = True
            elif current_latest is None:
                should_update_affiliation = True

            if should_update_affiliation:
                entry["_latest_publication_year"] = publication_year if isinstance(publication_year, int) else current_latest
                entry["current_affiliation"] = primary_affiliation
                entry["currently_local"] = bool(affiliation_local)
            override = author_overrides.get(author_id)
            if isinstance(override, dict):
                forced_current = override.get("force_currently_local")
                if isinstance(forced_current, bool):
                    entry["currently_local"] = forced_current

        source = extract_source(work)
        journal_id = None
        if source and source.get("id"):
            journal_id = source["id"]
            entry = journals_lookup.setdefault(
                journal_id,
                {
                    "id": journal_id,
                    "display_name": source.get("display_name"),
                    "issn_l": source.get("issn_l"),
                    "paper_ids": set(),
                },
            )
            entry["paper_ids"].add(work_id)

        papers_lookup[work_id] = {
            "id": work_id,
            "title": work.get("display_name") or work.get("title"),
            "doi": doi or None,
            "cited_by_count": work.get("cited_by_count"),
            "publication_year": work.get("publication_year"),
            "citation_stats_refreshed_at": work.get("citation_stats_refreshed_at"),
            "publication_date": work.get("publication_date"),
            "topic_ids": sorted(paper_to_topics.get(work_id, set())),
            "author_ids": author_refs,
            "journal_id": journal_id,
        }

    # finalize author and journal lookups
    for entry in authors_lookup.values():
        paper_ids = entry["paper_ids"]
        entry["paper_ids"] = sorted(paper_ids)
        entry["paper_count"] = len(paper_ids)
        entry.pop("_latest_publication_year", None)
    for entry in journals_lookup.values():
        paper_ids = entry["paper_ids"]
        entry["paper_ids"] = sorted(paper_ids)
        entry["paper_count"] = len(paper_ids)

    return papers_lookup, authors_lookup, journals_lookup


def build_library_datasets(
    papers_lookup: Dict[str, dict],
    authors_lookup: Dict[str, dict],
    journals_lookup: Dict[str, dict],
    paper_to_topics: Dict[str, Set[str]],
    topics: Dict[str, dict],
    works_by_id: Dict[str, dict],
) -> Tuple[List[dict], List[dict]]:
    """Construct publication and author datasets for the Library view."""
    topic_names = {tid: info.get("name") or f"Topic {tid}" for tid, info in topics.items()}

    def get_top_level_topic_id(topic_id: str) -> Optional[str]:
        current = topic_id
        visited: Set[str] = set()
        while current and current in topics:
            parent = topics[current].get("parent")
            if not parent:
                return current
            if parent in visited:
                break
            visited.add(parent)
            current = parent
        return current if current in topics and not topics[current].get("parent") else topic_id
    all_years_sorted = sorted(
        {
            int(year)
            for year in (
                paper.get("publication_year")
                for paper in papers_lookup.values()
            )
            if isinstance(year, int)
        }
    )

    def resolve_venue_label(paper_data: dict, work: dict) -> Optional[str]:
        journal_id = paper_data.get("journal_id")
        if journal_id:
            label = journals_lookup.get(journal_id, {}).get("display_name")
            if label:
                return label
        primary_source = (work.get("primary_location") or {}).get("source") or {}
        if primary_source.get("display_name"):
            return primary_source["display_name"]
        host_venue = work.get("host_venue") or {}
        if host_venue.get("display_name"):
            return host_venue["display_name"]
        return None

    publications: List[dict] = []
    for paper_id, paper_data in papers_lookup.items():
        author_refs = paper_data.get("author_ids") or []
        if not any(ref.get("local") for ref in author_refs):
            continue

        work = works_by_id.get(paper_id, {})
        title = (
            paper_data.get("title")
            or work.get("display_name")
            or work.get("title")
            or "Untitled"
        )
        year = paper_data.get("publication_year")
        citations = paper_data.get("cited_by_count")
        doi = paper_data.get("doi")
        venue_name = resolve_venue_label(paper_data, work) or paper_data.get("venue_name")

        authors_list = []
        for ref in author_refs:
            author = authors_lookup.get(ref.get("id") or "")
            if not author:
                continue
            author_item = {
                    "id": author["id"],
                    "name": author.get("display_name"),
                    "local": bool(ref.get("local")),
                }
            for field in ("authorship_roles", "is_byline_author", "byline_position", "author_position"):
                if field in ref:
                    author_item[field] = ref[field]
            authors_list.append(author_item)

        topic_ids = sorted(paper_to_topics.get(paper_id, set()))
        topic_tags = [
            {"id": tid, "name": topic_names.get(tid, tid)}
            for tid in topic_ids
        ]

        search_parts = [
            title,
            venue_name or "",
            " ".join(author.get("name") or "" for author in authors_list),
            " ".join(tag["name"] for tag in topic_tags),
            str(year or ""),
        ]

        publications.append(
            {
                "id": paper_id,
                "title": title,
                "year": year,
                "cited_by_count": citations,
                "doi": doi,
                "openalex_url": paper_id if paper_id else None,
                "venue": venue_name,
                "authors": authors_list,
                "topics": topic_tags,
                "search_blob": " ".join(search_parts).lower(),
            }
        )

    library_authors: List[dict] = []
    for author_id, author_data in authors_lookup.items():
        if not author_data.get("currently_local"):
            continue

        paper_ids = author_data.get("paper_ids") or []
        if not paper_ids:
            continue

        citation_total = 0
        topic_counter: Counter[str] = Counter()
        year_main_counter: Counter[int] = Counter()
        year_secondary_counter: Counter[int] = Counter()
        journal_counter: Counter[str] = Counter()
        journal_meta: Dict[str, dict] = {}
        coauthor_counter: Counter[str] = Counter()
        publication_details: List[dict] = []

        for pid in paper_ids:
            paper = papers_lookup.get(pid)
            if not paper:
                continue
            citations = paper.get("cited_by_count")
            if isinstance(citations, (int, float)):
                citation_total += int(citations)
            for tid in paper_to_topics.get(pid, set()):
                topic_counter[tid] += 1

            work = works_by_id.get(pid, {})
            venue_label = resolve_venue_label(paper, work)
            journal_id = paper.get("journal_id")
            if journal_id:
                journal_counter[journal_id] += 1
                meta = journals_lookup.get(journal_id, {}) or {}
                journal_meta[journal_id] = {
                    "name": meta.get("display_name") or venue_label or "Unknown journal",
                    "issn_l": meta.get("issn_l"),
                }
            elif venue_label:
                fallback_key = f"label::{venue_label}"
                journal_counter[fallback_key] += 1
                journal_meta[fallback_key] = {
                    "name": venue_label,
                    "issn_l": None,
                }

            author_refs = paper.get("author_ids") or []
            is_main = False
            for ref in author_refs:
                if ref.get("id") == author_id:
                    is_main = bool(ref.get("main_author"))
                elif ref.get("id"):
                    coauthor_counter[ref["id"]] += 1

            year = paper.get("publication_year")
            if isinstance(year, int):
                if is_main:
                    year_main_counter[year] += 1
                else:
                    year_secondary_counter[year] += 1

            publication_details.append(
                {
                    "id": pid,
                    "title": paper.get("title")
                    or (works_by_id.get(pid, {}) or {}).get("display_name")
                    or "Untitled",
                    "year": year if isinstance(year, int) else None,
                    "cited_by_count": paper.get("cited_by_count"),
                    "venue": venue_label,
                    "doi": paper.get("doi"),
                    "openalex_url": pid,
                    "is_main": bool(is_main),
                    "authors": [
                        name
                        for ref in author_refs
                        for name in [
                            authors_lookup.get(ref.get("id"), {}).get("display_name")
                            or ref.get("name")
                            or ref.get("raw_author_name")
                        ]
                        if name
                    ],
                }
            )

        top_topic_items = []
        for tid, count in topic_counter.most_common(6):
            top_topic_items.append(
                {
                    "id": tid,
                    "name": topic_names.get(tid, tid),
                    "label": topic_names.get(tid, tid),
                    "count": int(count),
                    "top_level_id": get_top_level_topic_id(tid),
                }
            )
        top_topics = [
            {"id": item["id"], "name": item["name"], "top_level_id": item["top_level_id"]}
            for item in top_topic_items
        ]

        current_affiliation = author_data.get("current_affiliation")
        if isinstance(current_affiliation, dict):
            affiliation_label = current_affiliation.get("display_name") or current_affiliation.get("id")
        else:
            affiliation_label = current_affiliation

        search_parts = [
            author_data.get("display_name") or "",
            affiliation_label or "",
            " ".join(tag["name"] for tag in top_topics),
        ]

        main_publications = sum(year_main_counter.values())
        year_series = []
        year_axis = all_years_sorted or sorted(set(year_main_counter.keys()) | set(year_secondary_counter.keys()))
        for year in year_axis:
            year_series.append(
                {
                    "year": year,
                    "main": int(year_main_counter.get(year, 0)),
                    "secondary": int(year_secondary_counter.get(year, 0)),
                }
            )

        top_journals = []
        for key, count in journal_counter.most_common(5):
            meta = journal_meta.get(key, {})
            label = meta.get("name") or (key.replace("label::", "") if isinstance(key, str) and key.startswith("label::") else key)
            top_journals.append(
                {
                    "id": key if isinstance(key, str) and key.startswith("http") else None,
                    "name": label or "Unknown journal",
                    "issn_l": meta.get("issn_l"),
                    "count": int(count),
                }
            )

        top_coauthors = []
        for co_id, count in coauthor_counter.most_common(5):
            author_record = authors_lookup.get(co_id, {}) or {}
            co_name = author_record.get("display_name") or co_id
            current_aff = author_record.get("current_affiliation")
            if isinstance(current_aff, dict):
                co_aff_label = current_aff.get("display_name") or current_aff.get("id")
            else:
                co_aff_label = current_aff
            top_coauthors.append(
                {
                    "id": co_id,
                    "name": co_name,
                    "affiliation": co_aff_label,
                    "count": int(count),
                    "is_local": bool(author_record.get("currently_local")),
                }
            )

        publication_details.sort(
            key=lambda item: (
                -int(item.get("cited_by_count") or 0),
                -int(item.get("year") or 0),
                item.get("title") or "",
            )
        )
        top_publications = publication_details[:5]

        library_authors.append(
            {
                "id": author_id,
                "name": author_data.get("display_name"),
                "affiliation": affiliation_label,
                "publication_count": author_data.get("paper_count", 0),
                "citation_count": citation_total,
                "topics": top_topic_items,
                "search_blob": " ".join(search_parts).lower(),
                "detail": {
                    "stats": {
                        "main_publications": int(main_publications),
                        "total_publications": int(author_data.get("paper_count", 0)),
                        "total_citations": int(citation_total),
                        "coauthor_total": int(len(coauthor_counter)),
                    },
                    "year_series": year_series,
                    "top_journals": top_journals,
                    "top_coauthors": top_coauthors,
                    "top_topics": [
                        {"id": item["id"], "name": item["name"], "count": item["count"]}
                        for item in top_topic_items[:5]
                    ],
                    "top_publications": top_publications,
                },
            }
        )

    return publications, library_authors


def build_reports_data(
    papers_lookup: Dict[str, dict],
    journals_lookup: Dict[str, dict],
    topics: Dict[str, dict],
    paper_to_topics: Dict[str, Set[str]],
) -> dict:
    """Aggregate lifetime citations by publication-year cohort, not citation year.

    Each work counts once overall and once in each distinct top-level topic.
    Consequently topic totals can overlap; summing them is not a corpus total.
    """
    years_stats: Dict[int, Dict[str, int]] = defaultdict(lambda: {"pubs": 0, "citations": 0})

    for paper in papers_lookup.values():
        year = paper.get("publication_year")
        if not isinstance(year, int):
            continue
        years_stats[year]["pubs"] += 1
        citations = paper.get("cited_by_count")
        if isinstance(citations, (int, float)):
            years_stats[year]["citations"] += int(citations)

    years_sorted = sorted(years_stats.keys())
    cumulative = 0
    years_records: List[dict] = []
    for year in years_sorted:
        stats = years_stats[year]
        cumulative += stats["citations"]
        years_records.append(
            {
                "year": year,
                "pubs": stats["pubs"],
                "citations": stats["citations"],
                "cum_citations": cumulative,
            }
        )

    total_citations = cumulative

    venue_records: List[dict] = []
    for venue_id, info in journals_lookup.items():
        paper_ids = info.get("paper_ids") or []
        count = len(paper_ids)
        if count == 0:
            continue
        venue_records.append(
            {
                "venue_id": venue_id,
                "venue_name": info.get("display_name") or "Unknown venue",
                "pubs": count,
            }
        )

    venue_records.sort(key=lambda item: (-item["pubs"], item["venue_name"]))

    topic_names = {tid: info.get("name") or f"Topic {tid}" for tid, info in topics.items()}

    def get_top_level(topic_id: str) -> Optional[str]:
        current = topic_id
        visited: Set[str] = set()
        while current and current in topics:
            parent = topics[current].get("parent")
            if not parent:
                return current
            if parent in visited:
                break
            visited.add(parent)
            current = parent
        return current if current in topics and not topics[current].get("parent") else None

    top_level_stats: Dict[str, dict] = {}
    for paper_id, paper in papers_lookup.items():
        year = paper.get("publication_year")
        if not isinstance(year, int):
            continue
        citations = paper.get("cited_by_count")
        citations_val = int(citations) if isinstance(citations, (int, float)) else 0
        roots: Set[str] = set()
        for tid in paper.get("topic_ids") or []:
            root = get_top_level(tid)
            if root:
                roots.add(root)
        if not roots:
            continue
        for root in roots:
            entry = top_level_stats.setdefault(
                root,
                {
                    "topic_id": root,
                    "topic": topic_names.get(root, root),
                    "per_year": defaultdict(lambda: {"pubs": 0, "citations": 0}),
                },
            )
            yearly = entry["per_year"][year]
            yearly["pubs"] += 1
            yearly["citations"] += citations_val

    topic_records: List[dict] = []
    for root_id, info in top_level_stats.items():
        per_year = info["per_year"]
        pubs_total = sum(v["pubs"] for v in per_year.values())
        cites_total = sum(v["citations"] for v in per_year.values())
        if pubs_total == 0:
            continue
        cum = 0
        series: List[dict] = []
        for year in years_sorted:
            stats = per_year.get(year)
            pubs = stats["pubs"] if stats else 0
            citations = stats["citations"] if stats else 0
            cum += citations
            series.append(
                {
                    "year": year,
                    "pubs": pubs,
                    "citations": citations,
                    "cum_citations": cum,
                }
            )
        topic_records.append(
            {
                "topic_id": root_id,
                "topic": info["topic"],
                "pubs_total": pubs_total,
                "cites_total": cites_total,
                "series": series,
            }
        )

    topic_records.sort(key=lambda item: (-item["pubs_total"], item["topic"]))

    refreshed = sorted(p["citation_stats_refreshed_at"] for p in papers_lookup.values()
                       if p.get("citation_stats_refreshed_at"))
    return {
        "citation_stats": {
            "year_basis": "publication_year",
            "metric": "lifetime_cited_by_count",
            "topic_counting": "full_count_per_distinct_top_level_topic",
            "papers": len(papers_lookup),
            "refreshed_papers": len(refreshed),
            "oldest_refresh": refreshed[0] if refreshed else None,
            "newest_refresh": refreshed[-1] if refreshed else None,
        },
        "publications": {
            "years": years_records,
            "venues": venue_records,
            "total_citations": total_citations,
        },
        "topics": {
            "topics": topic_records,
            "years": years_sorted,
        },
    }

def write_json(path: Path, payload: dict) -> None:
    """Serialize payload as formatted JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def load_existing_lookup(path: Path) -> dict:
    """Best-effort loader for the current topics lookup (used for diffs)."""
    try:
        if not path.exists():
            return {}
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception as exc:
        print(f"[diff] WARNING: failed to read existing lookup {path}: {exc}")
        return {}


def _paper_has_local_authors(paper: dict) -> bool:
    return any(ref.get("local") for ref in (paper or {}).get("author_ids") or [])


def _local_author_ids(authors: Dict[str, dict]) -> Set[str]:
    return {
        aid
        for aid, meta in (authors or {}).items()
        if (meta or {}).get("currently_local")
    }


def _local_paper_ids(papers: Dict[str, dict]) -> Set[str]:
    return {
        pid
        for pid, meta in (papers or {}).items()
        if _paper_has_local_authors(meta)
    }


def report_lookup_diffs(previous: dict, current: dict) -> None:
    """Print human-friendly diffs for local authors and papers with local authors."""
    prev_authors = previous.get("authors") or {}
    prev_papers = previous.get("papers") or {}
    curr_authors = current.get("authors") or {}
    curr_papers = current.get("papers") or {}

    prev_local_authors = _local_author_ids(prev_authors)
    curr_local_authors = _local_author_ids(curr_authors)
    added_authors = curr_local_authors - prev_local_authors
    removed_authors = prev_local_authors - curr_local_authors

    def author_label(aid: str, pool: Dict[str, dict]) -> str:
        name = (pool.get(aid) or {}).get("display_name") or (pool.get(aid) or {}).get("name")
        return f"{name} ({aid})" if name else aid

    prev_local_papers = _local_paper_ids(prev_papers)
    curr_local_papers = _local_paper_ids(curr_papers)
    added_papers = curr_local_papers - prev_local_papers
    removed_papers = prev_local_papers - curr_local_papers

    def paper_label(pid: str, pool: Dict[str, dict]) -> str:
        title = (pool.get(pid) or {}).get("title")
        return f"{title} ({pid})" if title else pid

    print("[diff] Local authors:")
    if added_authors:
        for aid in sorted(added_authors):
            print(f"  ++ {author_label(aid, curr_authors)}")
    if removed_authors:
        for aid in sorted(removed_authors):
            print(f"  -- {author_label(aid, prev_authors)}")
    if not added_authors and not removed_authors:
        print("  (no changes)")

    print("[diff] Publications with local authors:")
    if added_papers:
        for pid in sorted(added_papers):
            print(f"  ++ {paper_label(pid, curr_papers)}")
    if removed_papers:
        for pid in sorted(removed_papers):
            print(f"  -- {paper_label(pid, prev_papers)}")
    if not added_papers and not removed_papers:
        print("  (no changes)")


def log_papers_without_local_authors(papers_lookup: Dict[str, dict]) -> None:
    """Print papers that have no local authorship flagged."""
    missing: List[Tuple[str, str]] = []
    for paper_id, paper in papers_lookup.items():
        author_refs = paper.get("author_ids") or []
        if any(ref.get("local") for ref in author_refs):
            continue
        title = paper.get("title") or "Untitled"
        identifier = paper.get("doi") or paper_id
        missing.append((title, identifier))

    if not missing:
        print("[local-authors] All curated papers have at least one local author.")
        return

    print("[local-authors] Papers without local authors:")
    for title, identifier in sorted(missing, key=lambda item: (item[0] or "").lower()):
        print(f"  - {title} ({identifier})")


def print_summary_stats(
    curated_work_ids: Iterable[str],
    papers_lookup: Dict[str, dict],
    authors_lookup: Dict[str, dict],
) -> None:
    """Emit high-level counts about papers and authors."""
    total_input_papers = len(set(curated_work_ids))
    papers_with_local = sum(
        1 for paper in papers_lookup.values() if any(ref.get("local") for ref in paper.get("author_ids") or [])
    )
    authors_with_local_authorship = sum(
        1 for author in authors_lookup.values() if author.get("has_local_authorship")
    )
    authors_currently_local = sum(
        1 for author in authors_lookup.values() if author.get("currently_local")
    )
    print("[stats] Total input papers:", total_input_papers)
    print("[stats] Papers with local authors:", papers_with_local)
    print("[stats] Authors with local authorship:", authors_with_local_authorship)
    print("[stats] Authors currently local:", authors_currently_local)


def build_outputs(
    topics_csv: Path,
    publications_csv: Path,
    openalex_cache: Path,
    openalex_patch: Path,
    hierarchy_output: Path,
    lookup_output: Path,
    top_papers: int,
    top_keywords: int,
    top_journals: int,
    top_authors: int,
    output_dir: Optional[Path] = None,
) -> None:
    """Main orchestration helper."""
    output_dir = output_dir or lookup_output.parent
    topics = load_topics(topics_csv)
    patches = load_patches(openalex_patch)
    author_overrides = get_author_local_overrides(patches)
    print(f"[patches] works in file: {len((patches or {}).get('works', {}))}")

    works_by_id, works_by_doi = load_openalex_cache(openalex_cache)
    # Inject any additional works specified via the patches file before
    # applying patches or computing downstream metrics.
    apply_included_works(works_by_id, patches, openalex_patch)
    disable_raw_for = apply_work_patches(works_by_id, patches)
    works_by_id, works_by_doi = index_works(works_by_id.values())
    previous_lookup = load_existing_lookup(lookup_output)

    direct_assignments, paper_to_topics, curated_work_ids, unmatched_rows = aggregate_topic_assignments(
        publications_csv, topics, works_by_id, works_by_doi
    )
    apply_author_patches(works_by_id, curated_work_ids, patches)
    papers_lookup, authors_lookup, journals_lookup = build_lookup_tables(
        curated_work_ids, works_by_id, paper_to_topics, disable_raw_for, author_overrides
    )
    aggregated_papers = propagate_topic_papers(topics, direct_assignments)
    years = collect_years_from_works(curated_work_ids, works_by_id)
    metrics = compute_topic_metrics(
        topics,
        aggregated_papers,
        direct_assignments,
        works_by_id,
        authors_lookup,
        top_papers,
        top_keywords,
        top_journals,
        top_authors,
        years,
    )
    hierarchy = build_d3_hierarchy(topics, metrics, curated_work_ids, years, works_by_id)

    write_json(hierarchy_output, hierarchy)
    lookup_payload = {
        "papers": papers_lookup,
        "authors": authors_lookup,
        "journals": journals_lookup,
    }
    report_lookup_diffs(previous_lookup, lookup_payload)
    write_json(lookup_output, lookup_payload)

    library_publications, library_authors = build_library_datasets(
        papers_lookup,
        authors_lookup,
        journals_lookup,
        paper_to_topics,
        topics,
        works_by_id,
    )
    write_json(output_dir / "library_publications.json", {"items": library_publications})
    write_json(output_dir / "library_authors.json", {"items": library_authors})

    reports_payload = build_reports_data(
        papers_lookup,
        journals_lookup,
        topics,
        paper_to_topics,
    )
    write_json(output_dir / "reports.json", reports_payload)
    print_summary_stats(curated_work_ids, papers_lookup, authors_lookup)
    log_papers_without_local_authors(papers_lookup)

    # Report any publications that could not be matched in the OpenAlex cache.
    if unmatched_rows:
        print(
            f"\n[topics_to_d3] {len(unmatched_rows)} publication(s) in "
            f"{publications_csv} could not be matched in the OpenAlex cache:"
        )
        for row in unmatched_rows:
            identifier = row.get("identifier") or "(missing id)"
            title = row.get("title") or "(no title)"
            topics_str = ",".join(row.get("topics") or [])
            print(f"  - {identifier}; {title}; topics={topics_str}")
    else:
        print("\n[topics_to_d3] All tagged publications were matched in the OpenAlex cache.")


def default_path(rel_path: str) -> Path:
    """Resolve a path relative to the repository root."""
    return Path(__file__).resolve().parents[1] / rel_path


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    """CLI argument parsing."""
    parser = argparse.ArgumentParser(description="Generate D3 hierarchy and lookup tables from topic annotations.")
    parser.add_argument("--topics-csv", type=Path, default=Path(__file__).parent / "inputs/topics.csv")
    parser.add_argument("--publications-csv", type=Path, default=Path(__file__).parent / "inputs/publications_tagged.csv")
    parser.add_argument("--openalex-cache", type=Path, default=Path(__file__).parent / "cache/openalex_cache.json")
    parser.add_argument("--openalex-patch", type=Path, default=Path(__file__).parent / "patches/openalex_patches.json")
    parser.add_argument("--output-dir", type=Path, help="Destination for all generated JSON datasets")
    parser.add_argument("--hierarchy-output", type=Path, default=default_path("data/topics_hierarchy.json"))
    parser.add_argument("--lookup-output", type=Path, default=default_path("data/topics_lookup.json"))
    parser.add_argument("--top-papers", type=int, default=DEFAULT_TOP_PAPERS)
    parser.add_argument("--top-keywords", type=int, default=DEFAULT_TOP_KEYWORDS)
    parser.add_argument("--top-journals", type=int, default=DEFAULT_TOP_JOURNALS)
    parser.add_argument("--top-authors", type=int, default=DEFAULT_TOP_AUTHORS)
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> None:
    args = parse_args(argv)
    hierarchy_output = (args.output_dir / "topics_hierarchy.json") if args.output_dir else args.hierarchy_output
    lookup_output = (args.output_dir / "topics_lookup.json") if args.output_dir else args.lookup_output
    build_outputs(
        topics_csv=args.topics_csv,
        publications_csv=args.publications_csv,
        openalex_cache=args.openalex_cache,
        openalex_patch=args.openalex_patch,
        hierarchy_output=hierarchy_output,
        lookup_output=lookup_output,
        output_dir=args.output_dir,
        top_papers=args.top_papers,
        top_keywords=args.top_keywords,
        top_journals=args.top_journals,
        top_authors=args.top_authors,
    )
    print(f"Wrote hierarchy to {hierarchy_output}")
    print(f"Wrote lookup tables to {lookup_output}")


if __name__ == "__main__":
    main()
