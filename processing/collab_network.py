"""Generate the co-authorship network from the curated topics lookup output.

The previous pipeline consumed raw OpenAlex exports plus several CSV files to
identify local authors. That logic now lives inside ``topics_to_d3.py``, which
produces ``data/topics_lookup.json`` with curated paper, author, and journal
records. This script reuses that processed data to build the collaboration
network that powers the D3 visualization (``data/oa_coauth.json``) and the
auxiliary VOSviewer / GraphML / GEXF exports.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, MutableMapping, Optional, Sequence, Tuple

import networkx as nx

try:
    import community as community_louvain  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    community_louvain = None


DEFAULT_SAMPLE_PER_EDGE = 5
ROLE_KEYS = ("either_main", "both_main", "source_main", "target_main")


def default_path(rel_path: str) -> Path:
    """Resolve a repository-relative path."""
    return Path(__file__).resolve().parents[1] / rel_path


def load_topics_lookup(path: Path) -> Tuple[Dict[str, dict], Dict[str, dict]]:
    """Return the curated paper and author lookups produced by topics_to_d3.py."""
    with path.open("r", encoding="utf-8") as fh:
        payload = json.load(fh)
    papers = payload.get("papers") or {}
    authors = payload.get("authors") or {}
    if not isinstance(papers, dict) or not isinstance(authors, dict):
        raise ValueError("topics_lookup.json must contain 'papers' and 'authors' dictionaries")
    return papers, authors


def _position_for_index(index: int, total: int) -> str:
    if total <= 1:
        return "first"
    if index == 0:
        return "first"
    if index == total - 1:
        return "last"
    return "middle"


def _affiliation_candidates(author_info: dict) -> List[str]:
    """Return a stable list of string labels for the author's current affiliation."""
    aff = author_info.get("current_affiliation") or {}
    values: List[str] = []
    for key in ("display_name", "ror", "id"):
        val = aff.get(key)
        if val and val not in values:
            values.append(val)
    return values


def _init_author_record(author_id: str, author_info: dict) -> dict:
    candidates = _affiliation_candidates(author_info)
    return {
        "id": author_id,
        "name": author_info.get("display_name") or author_id,
        "orcid": author_info.get("orcid"),
        "affiliation": candidates[0] if candidates else None,
        "affiliations": candidates[:],
        "affiliation_candidates": candidates[:],
        "raw_affiliation_strings": set(),
        "papers": set(),
        "is_local": bool(author_info.get("currently_local")),
        "pub_count": 0,
        "main_pub_total": 0,
        "first_pub_total": 0,
        "last_pub_total": 0,
        "pubs_by_year": defaultdict(int),
        "main_pubs_by_year": defaultdict(int),
        "first_pubs_by_year": defaultdict(int),
        "last_pubs_by_year": defaultdict(int),
        "first_year": None,
        "last_year": None,
        "local_affiliation_pub_count": 0,
        "local_affiliation_start_year": None,
    }


def _update_author_record(
    record: dict,
    paper_id: str,
    year: Optional[int],
    *,
    is_main: bool,
    is_first: bool,
    is_last: bool,
    is_local_authorship: bool,
) -> None:
    """Accumulate publication counters for a single authorship."""
    record["pub_count"] += 1
    record["papers"].add(paper_id)

    if year is not None:
        key = str(year)
        record["pubs_by_year"][key] += 1
        if is_main:
            record["main_pubs_by_year"][key] += 1
        if is_first:
            record["first_pubs_by_year"][key] += 1
        if is_last:
            record["last_pubs_by_year"][key] += 1

    if is_main:
        record["main_pub_total"] += 1
    if is_first:
        record["first_pub_total"] += 1
    if is_last:
        record["last_pub_total"] += 1

    if year is not None:
        if record["first_year"] is None or year < record["first_year"]:
            record["first_year"] = year
        if record["last_year"] is None or year > record["last_year"]:
            record["last_year"] = year

    if is_local_authorship:
        record["is_local"] = True
        record["local_affiliation_pub_count"] += 1
        if (
            record["local_affiliation_start_year"] is None
            or (year is not None and year < record["local_affiliation_start_year"])
        ):
            record["local_affiliation_start_year"] = year


def _make_edge_record() -> dict:
    """Return the default structure for an edge accumulator."""
    return {
        "weight_full": 0.0,
        "weight_fractional": 0.0,
        "papers": set(),
        "counts_by_year": defaultdict(int),
        "role_pair_counts_by_year": {
            role: defaultdict(int)
            for role in ROLE_KEYS
        },
        "role_pair_totals": defaultdict(int),
        "papers_sample": [],
    }


def build_network_from_lookup(
    papers_lookup: Dict[str, dict],
    authors_lookup: Dict[str, dict],
    *,
    sample_per_edge: int = DEFAULT_SAMPLE_PER_EDGE,
) -> Tuple[Dict[str, dict], Dict[Tuple[str, str], dict], Dict[str, int]]:
    """Convert lookup tables into author + edge structures."""
    authors: Dict[str, dict] = {}
    edges: Dict[Tuple[str, str], dict] = {}

    stats = {
        "works_processed": 0,
        "authorships": 0,
        "pair_instances": 0,
    }

    for paper_id, paper in papers_lookup.items():
        author_refs = paper.get("author_ids") or []
        if not author_refs:
            continue
        year = paper.get("publication_year")
        stats["works_processed"] += 1

        author_entries = []
        total_authors = len(author_refs)
        for idx, ref in enumerate(author_refs):
            author_id = ref.get("id")
            if not author_id:
                continue
            stats["authorships"] += 1
            info = authors_lookup.get(author_id, {})
            record = authors.setdefault(author_id, _init_author_record(author_id, info))
            is_main = bool(ref.get("main_author"))
            # Curated bylines can precede hundreds of group contributors. Use
            # their verified positions instead of treating the last group member
            # as the publication's last author.
            position = ref.get("author_position") or _position_for_index(idx, total_authors)
            is_first = position == "first"
            is_last = position == "last"
            if total_authors == 1:
                is_first = True
                is_last = True
            local_flag = bool(ref.get("local") or info.get("currently_local"))

            _update_author_record(
                record,
                paper_id,
                year if isinstance(year, int) else None,
                is_main=is_main,
                is_first=is_first,
                is_last=is_last,
                is_local_authorship=local_flag,
            )

            author_entries.append(
                {
                    "id": author_id,
                    "is_local": local_flag,
                    "is_main": is_main,
                    "position": position,
                }
            )

        if len(author_entries) < 2:
            continue

        frac_weight = 1.0 / max(1, len(author_entries) - 1)
        for i in range(len(author_entries)):
            for j in range(i + 1, len(author_entries)):
                a = author_entries[i]
                b = author_entries[j]
                if not (a["is_local"] or b["is_local"]):
                    # Keep the focus on collaborations that involve the local institution.
                    continue
                key = tuple(sorted((a["id"], b["id"])))
                edge = edges.setdefault(key, _make_edge_record())
                stats["pair_instances"] += 1

                edge["weight_full"] += 1.0
                edge["weight_fractional"] += frac_weight
                edge["papers"].add(paper_id)

                if isinstance(year, int):
                    ykey = str(year)
                    edge["counts_by_year"][ykey] += 1
                else:
                    ykey = "unknown"

                if key[0] == a["id"]:
                    src = a
                    tgt = b
                else:
                    src = b
                    tgt = a

                if src["is_main"] or tgt["is_main"]:
                    edge["role_pair_counts_by_year"]["either_main"][ykey] += 1
                if src["is_main"] and tgt["is_main"]:
                    edge["role_pair_counts_by_year"]["both_main"][ykey] += 1
                if src["is_main"]:
                    edge["role_pair_counts_by_year"]["source_main"][ykey] += 1
                if tgt["is_main"]:
                    edge["role_pair_counts_by_year"]["target_main"][ykey] += 1

                if len(edge["papers_sample"]) < sample_per_edge:
                    edge["papers_sample"].append(
                        {
                            "id": paper_id,
                            "year": year if isinstance(year, int) else None,
                            "source_pos": src["position"],
                            "target_pos": tgt["position"],
                        }
                    )

    _finalize_authors(authors)
    _finalize_edges(edges)
    return authors, edges, stats


def _finalize_authors(authors: MutableMapping[str, dict]) -> None:
    """Convert mutable counters and sets into JSON-serializable structures."""
    for record in authors.values():
        for key in ("pubs_by_year", "main_pubs_by_year", "first_pubs_by_year", "last_pubs_by_year"):
            mapping = record.get(key, {})
            record[key] = {k: int(v) for k, v in mapping.items()}
        record["papers"] = sorted(record.get("papers", set()))
        record["local_affiliation_pub_count"] = int(record.get("local_affiliation_pub_count", 0))
        if record.get("local_affiliation_start_year") is not None:
            record["local_affiliation_start_year"] = int(record["local_affiliation_start_year"])
        record["raw_affiliation_strings"] = list(record.get("raw_affiliation_strings", []))


def _finalize_edges(edges: MutableMapping[Tuple[str, str], dict]) -> None:
    for edge in edges.values():
        edge["papers"] = sorted(edge.get("papers", set()))
        edge["counts_by_year"] = {k: int(v) for k, v in edge.get("counts_by_year", {}).items()}
        role_maps = edge.get("role_pair_counts_by_year", {})
        finalized = {}
        totals = {}
        for role in ROLE_KEYS:
            year_map = role_maps.get(role, {})
            year_map = {k: int(v) for k, v in year_map.items()}
            finalized[role] = year_map
            totals[role] = sum(year_map.values())
        edge["role_pair_counts_by_year"] = finalized
        edge["role_pair_totals"] = totals


def _summarize_stats(authors: Dict[str, dict], edges: Dict[Tuple[str, str], dict], stats: Dict[str, int]) -> Dict[str, int]:
    """Extend stats with counts that depend on the final structures."""
    summary = dict(stats)
    summary["total_authors"] = len(authors)
    summary["local_authors_count"] = sum(1 for info in authors.values() if info.get("is_local"))
    summary["total_edges"] = len(edges)

    local_local = 0
    local_external = 0
    for (u, v) in edges.keys():
        u_local = bool(authors.get(u, {}).get("is_local"))
        v_local = bool(authors.get(v, {}).get("is_local"))
        if u_local and v_local:
            local_local += 1
        else:
            local_external += 1
    summary["local_local_edges"] = local_local
    summary["local_external_edges"] = local_external
    return summary


def build_graph_and_metrics_light(authors: Dict[str, dict], edges: Dict[Tuple[str, str], dict]) -> nx.Graph:
    """Create a NetworkX graph decorated with author and edge metrics."""
    G = nx.Graph()
    for author_id, info in authors.items():
        G.add_node(
            author_id,
            name=info.get("name"),
            is_local=bool(info.get("is_local")),
            pub_count=int(info.get("pub_count", 0)),
            local_affiliation_pub_count=int(info.get("local_affiliation_pub_count", 0)),
            local_affiliation_start_year=(
                int(info["local_affiliation_start_year"])
                if info.get("local_affiliation_start_year") is not None
                else None
            ),
            first_year=int(info.get("first_year", -1)) if info.get("first_year") is not None else -1,
            last_year=int(info.get("last_year", -1)) if info.get("last_year") is not None else -1,
            affiliation=info.get("affiliation"),
            affiliations=";".join(info.get("affiliation_candidates", [])) if info.get("affiliation_candidates") else "",
            pubs_by_year=info.get("pubs_by_year", {}),
            main_pubs_by_year=info.get("main_pubs_by_year", {}),
        )

    for (a1, a2), edata in edges.items():
        if not G.has_node(a1) or not G.has_node(a2):
            continue
        G.add_edge(
            a1,
            a2,
            weight_full=float(edata.get("weight_full", 0.0)),
            weight_fractional=float(edata.get("weight_fractional", 0.0)),
            papers=";".join(edata.get("papers", [])) if edata.get("papers") else "",
            papers_count=int(len(edata.get("papers", []))),
            counts_by_year=edata.get("counts_by_year", {}),
            role_pair_counts_by_year=edata.get("role_pair_counts_by_year", {}),
            role_pair_totals=edata.get("role_pair_totals", {}),
        )

    weighted_deg = {
        node: sum(data.get("weight_fractional", 0.0) for _, _, data in G.edges(node, data=True))
        for node in G.nodes()
    }
    nx.set_node_attributes(G, weighted_deg, "weighted_degree")

    if community_louvain is not None:
        try:
            partition = community_louvain.best_partition(G, weight="weight_fractional")
        except Exception:
            partition = {n: 0 for n in G.nodes()}
    else:  # pragma: no cover
        partition = {n: 0 for n in G.nodes()}
    nx.set_node_attributes(G, partition, "community")

    return G


def export_vosviewer_files(
    graph: nx.Graph,
    out_map: str = "vos_map.tsv",
    out_network: str = "vos_network.tsv",
) -> Tuple[Dict[str, int], str, str]:
    """Export the VOSviewer tab-separated files."""
    nodes = list(graph.nodes())
    idmap = {node: idx + 1 for idx, node in enumerate(nodes)}
    header = ["id", "label", "cluster", "weight<Documents>", "weight<Links>"]
    rows = []
    for node in nodes:
        data = graph.nodes[node]
        community = int(data.get("community", 0) or 0)
        pubs = int(data.get("pub_count", 0) or 0)
        links_strength = float(data.get("weighted_degree", 0.0) or 0.0)
        label = data.get("name") or str(node)
        rows.append((idmap[node], label, community, pubs, round(links_strength, 4)))

    Path(out_map).parent.mkdir(parents=True, exist_ok=True)
    with open(out_map, "w", encoding="utf-8") as fh:
        fh.write("\t".join(header) + "\n")
        for row in rows:
            label = row[1]
            if ("," in label) or (";" in label):
                label = f'"{label}"'
            fh.write(f"{row[0]}\t{label}\t{row[2]}\t{row[3]}\t{row[4]}\n")

    with open(out_network, "w", encoding="utf-8") as fh:
        for u, v, data in graph.edges(data=True):
            i1 = idmap[u]
            i2 = idmap[v]
            weight = data.get("weight_fractional", data.get("weight_full", 1.0))
            fh.write(f"{i1}\t{i2}\t{round(weight, 4)}\n")

    return idmap, out_map, out_network


def export_json_and_graph_formats(
    authors: Dict[str, dict],
    edges: Dict[Tuple[str, str], dict],
    graph: nx.Graph,
    *,
    out_json: str = "network.json",
    out_gml: str = "network.graphml",
    out_gexf: str = "network.gexf",
    sample_per_edge: int = DEFAULT_SAMPLE_PER_EDGE,
    keep_first_last_years: bool = True,
) -> Tuple[str, str, str]:
    """Serialize the rich JSON plus GraphML and GEXF versions."""
    year_set = set()
    for author in authors.values():
        for key in ("pubs_by_year", "main_pubs_by_year"):
            for year in (author.get(key) or {}).keys():
                try:
                    year_set.add(int(year))
                except Exception:
                    continue

    for edge in edges.values():
        for year in (edge.get("counts_by_year") or {}).keys():
            try:
                year_set.add(int(year))
            except Exception:
                continue
        for role_map in (edge.get("role_pair_counts_by_year") or {}).values():
            for year in role_map.keys():
                try:
                    year_set.add(int(year))
                except Exception:
                    continue

    pub_years = sorted(year_set)
    config = {
        "min_year": min(pub_years) if pub_years else None,
        "max_year": max(pub_years) if pub_years else None,
        "years": pub_years,
        "generated_at": datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
    }

    def dict_to_arrays(years_index: List[int], yearmap: Optional[Dict[str, int]]) -> Tuple[List[int], List[int]]:
        yearmap_int = {int(k): int(v) for k, v in (yearmap or {}).items()}
        arr = [yearmap_int.get(year, 0) for year in years_index]
        cumulative: List[int] = []
        running = 0
        for value in arr:
            running += int(value)
            cumulative.append(running)
        return arr, cumulative

    nodes = []
    for author_id, info in authors.items():
        counts_arr, counts_cum = dict_to_arrays(pub_years, info.get("pubs_by_year"))
        main_arr, main_cum = dict_to_arrays(pub_years, info.get("main_pubs_by_year"))

        node_payload = {
            "id": author_id,
            "label": info.get("name") or author_id,
            "orcid": info.get("orcid"),
            "is_local": bool(info.get("is_local", False)),
            "pub_count": int(info.get("pub_count", 0)),
            "main_pub_total": int(info.get("main_pub_total", 0)),
            "pub_years": pub_years,
            "counts_by_year": counts_arr,
            "counts_by_year_cum": counts_cum,
            "main_pubs_by_year": main_arr,
            "main_pubs_by_year_cum": main_cum,
            "first_year": int(info.get("first_year"))
            if (info.get("first_year") is not None and keep_first_last_years)
            else None,
            "last_year": int(info.get("last_year"))
            if (info.get("last_year") is not None and keep_first_last_years)
            else None,
            "affiliations": info.get("affiliations") or info.get("affiliation_candidates") or [],
            "raw_affiliation_strings": list(info.get("raw_affiliation_strings") or [])[:50],
            "papers": list(info.get("papers") or [])[:200],
        }

        graph_node = graph.nodes.get(author_id, {}) if graph is not None else {}
        if graph_node:
            node_payload["weighted_degree"] = float(graph_node.get("weighted_degree", 0.0))
            node_payload["community"] = int(graph_node.get("community", 0) or 0)
            if graph_node.get("affiliation"):
                node_payload["affiliation"] = graph_node.get("affiliation")

        nodes.append(node_payload)

    links = []
    for (u, v), edge in edges.items():
        counts_arr, counts_cum = dict_to_arrays(pub_years, edge.get("counts_by_year"))
        role_arrays = {}
        role_cums = {}
        for role in ROLE_KEYS:
            arr, cum = dict_to_arrays(pub_years, edge.get("role_pair_counts_by_year", {}).get(role))
            role_arrays[role] = arr
            role_cums[role] = cum

        links.append(
            {
                "source": u,
                "target": v,
                "papers_count": int(len(edge.get("papers", []))),
                "pub_years": pub_years,
                "counts_by_year": counts_arr,
                "counts_by_year_cum": counts_cum,
                "role_pair_counts_by_year_arrays": role_arrays,
                "role_pair_counts_by_year_cum": role_cums,
                "role_pair_totals": {rk: int(tv) for rk, tv in (edge.get("role_pair_totals") or {}).items()},
                "papers_sample": (edge.get("papers_sample") or [])[:sample_per_edge],
                "weight_fractional": float(edge.get("weight_fractional", 0.0)),
                "weight_full": float(edge.get("weight_full", 0.0)),
            }
        )

    net_payload = {"config": config, "nodes": nodes, "links": links}
    Path(out_json).parent.mkdir(parents=True, exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(net_payload, fh, indent=2, ensure_ascii=False)

    def _sanitize(value):
        if value is None:
            return ""
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    graph_for_serialization = nx.Graph()
    for node in nodes:
        attrs = {k: _sanitize(v) for k, v in node.items() if k != "id"}
        graph_for_serialization.add_node(node["id"], **attrs)

    for edge in links:
        attrs = {k: _sanitize(v) for k, v in edge.items() if k not in ("source", "target")}
        graph_for_serialization.add_edge(edge["source"], edge["target"], **attrs)

    Path(out_gml).parent.mkdir(parents=True, exist_ok=True)
    nx.write_graphml(graph_for_serialization, out_gml)
    nx.write_gexf(graph_for_serialization, out_gexf)

    return out_json, out_gml, out_gexf


def run_pipeline(
    lookup_json: Path,
    out_prefix: Path | str,
    *,
    sample_per_edge: int = DEFAULT_SAMPLE_PER_EDGE,
) -> Dict[str, object]:
    """High-level helper used by the CLI entrypoint."""
    papers_lookup, authors_lookup = load_topics_lookup(lookup_json)
    authors, edges, stats = build_network_from_lookup(
        papers_lookup,
        authors_lookup,
        sample_per_edge=sample_per_edge,
    )
    stats = _summarize_stats(authors, edges, stats)

    print("=== COLLABORATION NETWORK SUMMARY ===")
    print(f"Works processed: {stats['works_processed']}")
    print(f"Total authors: {stats['total_authors']} (local: {stats['local_authors_count']})")
    print(
        f"Edges: {stats['total_edges']} "
        f"(local-local: {stats['local_local_edges']}, local-external: {stats['local_external_edges']})"
    )

    graph = build_graph_and_metrics_light(authors, edges)

    prefix = Path(out_prefix)
    prefix.parent.mkdir(parents=True, exist_ok=True)
    base = str(prefix)

    _, map_path, net_path = export_vosviewer_files(
        graph,
        out_map=f"{base}_vos_map.tsv",
        out_network=f"{base}_vos_network.tsv",
    )
    json_path, gml_path, gexf_path = export_json_and_graph_formats(
        authors,
        edges,
        graph,
        out_json=f"{base}.json",
        out_gml=f"{base}.graphml",
        out_gexf=f"{base}.gexf",
        sample_per_edge=sample_per_edge,
    )

    print("Wrote:", map_path, net_path, json_path, gml_path, gexf_path)

    return {
        "map": map_path,
        "network": net_path,
        "json": json_path,
        "graphml": gml_path,
        "gexf": gexf_path,
        "stats": stats,
    }


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the collaboration network from topics_lookup.json")
    parser.add_argument(
        "--lookup-json",
        type=Path,
        default=default_path("data/topics_lookup.json"),
        help="Path to data/topics_lookup.json generated by topics_to_d3.py",
    )
    parser.add_argument(
        "--output-prefix",
        type=Path,
        default=default_path("data/oa_coauth"),
        help="Prefix for generated files (default: data/oa_coauth)",
    )
    parser.add_argument(
        "--sample-per-edge",
        type=int,
        default=DEFAULT_SAMPLE_PER_EDGE,
        help="Maximum number of example papers stored per edge",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> None:
    args = parse_args(argv)
    run_pipeline(
        lookup_json=args.lookup_json,
        out_prefix=args.output_prefix,
        sample_per_edge=args.sample_per_edge,
    )


if __name__ == "__main__":
    main()
