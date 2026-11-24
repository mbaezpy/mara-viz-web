"""
openalex_patcher.py — lightweight patch system for OpenAlex work metadata.

Patch file schema (informal)
----------------------------
{
  "stats_file": "openalex_stats.json",         # optional, statistics-only snapshot applied last
  "works": {
    "<openalex_work_id or normalized_doi>": {
      "mode": "merge | replace",                 # default: "merge"
      "disable_raw_affiliations": true,          # optional (work-wide)
      "work_overrides": { ... },                 # dict of top-level work fields to override (merged or replaced)
      "work_overrides_file": "work.authorships.json", # optional JSON object, relative to this patch file

      # --- batch operations (optional) ---
      "remove_institutions_for_authors": {       # batch remove selected institutions/affiliations/raws
        "authors": "*" | {match} | [{match}, ...],
        "by": [ { "id": "..."} | {"ror":"..."} | {"display_name":"..."} ],
        "remove_affiliations": [
          { "raw_affiliation_string": "..." } |
          { "institution_id": "https://openalex.org/I..." }
        ],
        "remove_raw_affiliation_strings": ["...exact string..."]
      },

      "set_affiliation_for_authors": {           # batch set/replace affiliation fields
        "authors": "*" | {match} | [{match}, ...],
        "mode": "replace" | "merge",             # default: "replace" for provided keys
        "unset": ["countries"],                  # optional: unset these keys before setting
        "set": {
          "institutions": [ {...} ],
          "affiliations": [ {...} ],
          "raw_affiliation_strings": ["..."],
          "...": "..."                           # any other authorship fields to set
        }
      },

      # --- per-authorship targeted edits (optional) ---
      "authorships": [
        {
          "match": {                             # how to find the authorship to edit (first match wins)
            "author_id": "https://openalex.org/A...",
            "orcid": "https://orcid.org/....",
            "display_name": "Exact Name"
          },
          "action": "merge | replace",           # default: "merge" (on the fields you set)
          "set": { ... },                        # dict to merge/replace into the authorship
          "unset": ["countries", "foo"],         # fields to remove from that authorship

          # selective removals (optional)
          "remove_institutions": [
            { "id": "https://openalex.org/I..." } |
            { "ror": "https://ror.org/..." } |
            { "display_name": "Exact Name" }
          ],
          "remove_affiliations": [
            { "raw_affiliation_string": "..." } |
            { "institution_id": "https://openalex.org/I..." }
          ],
          "remove_raw_affiliation_strings": ["...exact string..."]
        }
      ]
    }
  }
}

Usage
-----
from openalex_patcher import load_patches, apply_work_patches

patches = load_patches(Path("processing/patches/openalex_patches.json"))
disable_raw_for = apply_work_patches(works_by_id, patches)

# Later in your code, gate raw parsing like:
raw_enabled = work_id not in disable_raw_for
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
import re
from typing import Dict, Optional, Set, Any, List, Iterable


# -----------------------
# loading & basic helpers
# -----------------------

def load_patches(path: Optional[Path]) -> dict:
    """
    Load patches JSON. Returns {"works": { ... }} even if file is missing/empty.
    """
    if not path:
        return {"works": {}}
    try:
        if not path.exists():
            return {"works": {}}
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return {"works": {}}
        # Ensure there is always a "works" mapping; leave other keys as-is so
        # callers (and tests) see the original structure untouched.
        if not isinstance(data.get("works"), dict):
            data["works"] = {}
    except Exception as e:
        # Fail-closed: return empty patches if file is malformed
        print(f"[patches] WARNING: failed to load {path}: {e}")
        return {"works": {}}
    return resolve_work_overrides(data, path)


def resolve_work_overrides(patches: dict, patches_path: Path) -> dict:
    """Load large curated work overrides from adjacent JSON files.

    Inline work_overrides take precedence. Missing or malformed referenced files
    raise an error so an incomplete correction cannot silently reach a build.
    """
    for work_id, patch in (patches.get("works") or {}).items():
        if not isinstance(patch, dict) or "work_overrides_file" not in patch:
            continue
        relative = patch["work_overrides_file"]
        if not isinstance(relative, str) or not relative.strip():
            raise ValueError(f"{work_id}: work_overrides_file must be a filename")
        path = patches_path.parent / relative
        try:
            overrides = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ValueError(f"Cannot load work overrides for {work_id} from {path}: {exc}") from exc
        inline = patch.get("work_overrides", {})
        if not isinstance(overrides, dict) or not isinstance(inline, dict):
            raise ValueError(f"{path}: work overrides must be a JSON object")
        patch["work_overrides"] = deep_merge(overrides, inline)
    # Citation snapshots are applied last and may only override statistical fields.
    # In particular, they cannot replace reviewed authorships or publication dates.
    stats_file = patches.get("stats_file")
    if stats_file is not None:
        if not isinstance(stats_file, str) or not stats_file.strip():
            raise ValueError("stats_file must be a filename")
        stats = load_citation_stats(patches_path.parent / stats_file)
        for work_id, fields in stats["works"].items():
            patch = patches.setdefault("works", {}).setdefault(work_id, {"mode": "merge"})
            patch.setdefault("work_overrides", {}).update(fields)
    return patches


CITATION_STATS_FIELDS = {
    "cited_by_count", "counts_by_year", "citation_stats_refreshed_at",
    "citation_stats_source_updated_at", "citation_stats_source_work_id",
}


def validate_citation_stats(work_id: str, fields: dict) -> None:
    """Reject incomplete snapshots and any non-statistical metadata overrides."""
    if not isinstance(work_id, str) or not re.fullmatch(r"https://openalex.org/W\d+", work_id):
        raise ValueError(f"Invalid citation statistics work ID: {work_id!r}")
    if not isinstance(fields, dict) or set(fields) != CITATION_STATS_FIELDS:
        raise ValueError(f"{work_id}: citation statistics must contain only {sorted(CITATION_STATS_FIELDS)}")
    count = fields["cited_by_count"]
    if type(count) is not int or count < 0:
        raise ValueError(f"{work_id}: cited_by_count must be a non-negative integer")
    yearly = fields["counts_by_year"]
    if not isinstance(yearly, list):
        raise ValueError(f"{work_id}: counts_by_year must be a list")
    years = set()
    for row in yearly:
        if (not isinstance(row, dict) or set(row) != {"year", "cited_by_count"}
                or type(row["year"]) is not int or row["year"] <= 0
                or type(row["cited_by_count"]) is not int or row["cited_by_count"] < 0
                or row["year"] in years):
            raise ValueError(f"{work_id}: invalid or duplicate counts_by_year entry")
        years.add(row["year"])
    for key in ("citation_stats_refreshed_at", "citation_stats_source_updated_at"):
        value = fields[key]
        if value is None and key == "citation_stats_source_updated_at":
            continue
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (TypeError, AttributeError, ValueError) as exc:
            raise ValueError(f"{work_id}: invalid {key}") from exc
    if not re.fullmatch(r"https://openalex.org/W\d+", str(fields["citation_stats_source_work_id"])):
        raise ValueError(f"{work_id}: invalid citation_stats_source_work_id")


def load_citation_stats(path: Path) -> dict:
    """Strict loader: a broken configured snapshot must stop the build."""
    try:
        snapshot = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(snapshot, dict) or snapshot.get("schema_version") != 1
                or not isinstance(snapshot.get("works"), dict)):
            raise ValueError("expected schema_version 1 and a works mapping")
        for work_id, fields in snapshot["works"].items():
            validate_citation_stats(work_id, fields)
        return snapshot
    except (OSError, ValueError) as exc:
        raise ValueError(f"Cannot load citation statistics from {path}: {exc}") from exc


def _normalize_doi(value: Optional[str]) -> str:
    if not value:
        return ""
    v = value.strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi:"):
        if v.startswith(prefix):
            v = v[len(prefix):]
            break
    return v.strip()


def _index_by_doi(works_by_id: Dict[str, dict]) -> Dict[str, dict]:
    idx: Dict[str, dict] = {}
    for w in works_by_id.values():
        doi = w.get("doi") or (w.get("ids") or {}).get("doi")
        doi = _normalize_doi(doi)
        if doi:
            idx[doi] = w
    return idx


def apply_included_works(
    works_by_id: Dict[str, dict],
    patches: Optional[dict],
    patches_path: Optional[Path] = None,
) -> None:
    """
    Inject additional works into the OpenAlex cache based on the
    top-level "include" list in the patches JSON.

    Each entry in "include" is expected to be a path (absolute or
    relative to the patches file) pointing to a JSON file containing
    one full OpenAlex work record.
    """
    if not isinstance(works_by_id, dict) or not isinstance(patches, dict):
        return

    include_spec = patches.get("include")
    if not include_spec:
        return

    if isinstance(include_spec, str):
        include_paths = [include_spec]
    elif isinstance(include_spec, list):
        include_paths = [p for p in include_spec if isinstance(p, str)]
    else:
        return

    base_dir: Optional[Path] = None
    if isinstance(patches_path, Path):
        try:
            base_dir = patches_path.parent
        except Exception:
            base_dir = None

    for rel in include_paths:
        path = Path(rel)
        if not path.is_absolute() and base_dir is not None:
            path = base_dir / path
        try:
            with path.open("r", encoding="utf-8") as fh:
                work = json.load(fh)
        except Exception as exc:  # pragma: no cover - defensive logging
            print(f"[patches] WARNING: failed to load included work from {path}: {exc}")
            continue

        if not isinstance(work, dict):
            print(f"[patches] WARNING: included file {path} did not contain a JSON object")
            continue

        work_id = work.get("id")
        if not isinstance(work_id, str) or not work_id.strip():
            print(f"[patches] WARNING: included work in {path} is missing a valid 'id'")
            continue

        work_id = work_id.strip()
        existing = works_by_id.get(work_id)
        if existing is None:
            works_by_id[work_id] = work
        else:
            # Existing entry: deep-merge so that injected metadata can enrich
            # an existing cache record without losing fields.
            works_by_id[work_id] = deep_merge(existing, work)


def deep_merge(dst: Any, src: Any) -> Any:
    """
    Minimal deep merge: dicts merge recursively; lists/scalars replace.
    Returns the merged value (mutates dst in-place for dicts).
    """
    if isinstance(dst, dict) and isinstance(src, dict):
        for k, v in src.items():
            if k in dst:
                dst[k] = deep_merge(dst[k], v)
            else:
                dst[k] = v
        return dst
    # For lists/scalars or mismatched types, src wins
    return src


# -----------------------
# matching helpers
# -----------------------

def _match_authorship(auth: dict, match: dict) -> bool:
    """
    Match an authorship by author_id OR orcid OR exact display_name (first present in 'match').
    """
    if not isinstance(auth, dict) or not isinstance(match, dict):
        return False
    a = auth.get("author") or {}
    if match.get("author_id"):
        return a.get("id") == match["author_id"]
    if match.get("orcid"):
        return a.get("orcid") == match["orcid"]
    if match.get("display_name"):
        return a.get("display_name") == match["display_name"]
    return False


def _author_match(auth: dict, match: dict) -> bool:
    """Generic match used by batch ops; accepts any of author_id/orcid/display_name."""
    if not isinstance(auth, dict) or not isinstance(match, dict):
        return False
    a = (auth or {}).get("author") or {}
    return (
        (match.get("author_id") and a.get("id") == match["author_id"]) or
        (match.get("orcid") and a.get("orcid") == match["orcid"]) or
        (match.get("display_name") and a.get("display_name") == match["display_name"])
    )


def _any_author_match(auth: dict, matches) -> bool:
    """
    matches can be "*", a single {match}, or a list of {match}.
    """
    if matches == "*" or matches is None:
        return True
    if isinstance(matches, dict):
        return _author_match(auth, matches)
    if isinstance(matches, list):
        return any(_author_match(auth, m) for m in matches if isinstance(m, dict))
    return False


# -----------------------
# selective removals (per authorship)
# -----------------------

def _apply_authorship_edit(auth: dict, edit: dict) -> None:
    """
    Apply one authorship edit in-place.

    Supported edit keys:
      - action: "merge" | "replace"   (default: "merge")
      - set: dict                     (fields to merge/replace into authorship)
      - unset: list[str]              (fields to remove from authorship)
      - remove_institutions:          (selectively drop entries from institutions[])
          [
            { "id": "https://openalex.org/I...", "ror": "...", "display_name": "..." },
            ...
          ]
      - remove_affiliations:          (selectively drop entries from affiliations[])
          [
            { "raw_affiliation_string": "..." } |
            { "institution_id": "https://openalex.org/I..." }
          ]
      - remove_raw_affiliation_strings: list[str]  (exact-match removal from raw_affiliation_strings[])
    """
    if not isinstance(auth, dict) or not isinstance(edit, dict):
        return

    # 1) Unset whole fields first (if requested)
    for field in edit.get("unset", []) or []:
        if field in auth:
            auth.pop(field, None)

    # Helper: institution match
    def _inst_matches(inst: dict, rm: dict) -> bool:
        if not isinstance(inst, dict) or not isinstance(rm, dict):
            return False
        if rm.get("id") and inst.get("id") == rm["id"]:
            return True
        if rm.get("ror") and inst.get("ror") == rm["ror"]:
            return True
        if rm.get("display_name") and inst.get("display_name") == rm["display_name"]:
            return True
        return False

    # Helper: affiliation match
    def _aff_matches(aff: dict, rm: dict) -> bool:
        if not isinstance(aff, dict) or not isinstance(rm, dict):
            return False
        if rm.get("raw_affiliation_string") and aff.get("raw_affiliation_string") == rm["raw_affiliation_string"]:
            return True
        if rm.get("institution_id"):
            for iid in aff.get("institution_ids") or []:
                if iid == rm["institution_id"]:
                    return True
        return False

    # 2a) institutions[]
    rm_insts = edit.get("remove_institutions") or []
    if rm_insts and isinstance(auth.get("institutions"), list):
        keep = []
        for inst in auth.get("institutions") or []:
            if any(_inst_matches(inst, rm) for rm in rm_insts):
                continue
            keep.append(inst)
        auth["institutions"] = keep

    # 2b) affiliations[]
    rm_affs = edit.get("remove_affiliations") or []
    if rm_affs and isinstance(auth.get("affiliations"), list):
        keep = []
        for aff in auth.get("affiliations") or []:
            if any(_aff_matches(aff, rm) for rm in rm_affs):
                continue
            keep.append(aff)
        auth["affiliations"] = keep

    # 2c) raw_affiliation_strings[]
    rm_raws = edit.get("remove_raw_affiliation_strings") or []
    if rm_raws and isinstance(auth.get("raw_affiliation_strings"), list):
        auth["raw_affiliation_strings"] = [
            s for s in (auth.get("raw_affiliation_strings") or []) if s not in rm_raws
        ]

    # 3) Apply set payload via merge/replace
    action = (edit.get("action") or "merge").lower()
    payload = edit.get("set") or {}
    if action == "replace":
        # replace only specified keys
        for k, v in payload.items():
            auth[k] = v
    else:
        # merge: dicts deep-merge, lists/scalars replace
        deep_merge(auth, payload)


# -----------------------
# batch operations (work level)
# -----------------------

def _inst_matches_spec(inst: dict, spec: dict) -> bool:
    return (
        (spec.get("id") and inst.get("id") == spec["id"]) or
        (spec.get("ror") and inst.get("ror") == spec["ror"]) or
        (spec.get("display_name") and inst.get("display_name") == spec["display_name"])
    )


def _aff_matches_spec(aff: dict, spec: dict) -> bool:
    if spec.get("raw_affiliation_string") and aff.get("raw_affiliation_string") == spec["raw_affiliation_string"]:
        return True
    iid = spec.get("institution_id")
    if iid and any(i == iid for i in (aff.get("institution_ids") or [])):
        return True
    return False


def _batch_remove_institutions(authorships: List[dict], cfg: dict) -> None:
    """
    cfg = {
      "authors": "*" | {match} | [{match},...],
      "by": [{ "id": "..."} | {"ror":"..."} | {"display_name":"..."}],
      "remove_affiliations": [ { "raw_affiliation_string": "..." } | {"institution_id":"..."} ],
      "remove_raw_affiliation_strings": ["..."]
    }
    """
    if not isinstance(authorships, list) or not isinstance(cfg, dict):
        return
    by = cfg.get("by") or []
    rm_affs = cfg.get("remove_affiliations") or []
    rm_raws = cfg.get("remove_raw_affiliation_strings") or []

    for auth in authorships:
        if not _any_author_match(auth, cfg.get("authors")):
            continue

        # institutions[]
        if by and isinstance(auth.get("institutions"), list):
            keep = []
            for inst in auth.get("institutions") or []:
                if any(_inst_matches_spec(inst, spec) for spec in by):
                    continue
                keep.append(inst)
            auth["institutions"] = keep

        # affiliations[]
        if rm_affs and isinstance(auth.get("affiliations"), list):
            keep_aff = []
            for aff in auth.get("affiliations") or []:
                if any(_aff_matches_spec(aff, spec) for spec in rm_affs):
                    continue
                keep_aff.append(aff)
            auth["affiliations"] = keep_aff

        # raw_affiliation_strings[]
        if rm_raws and isinstance(auth.get("raw_affiliation_strings"), list):
            auth["raw_affiliation_strings"] = [
                s for s in (auth.get("raw_affiliation_strings") or []) if s not in rm_raws
            ]


def _batch_set_affiliation(authorships: List[dict], cfg: dict) -> None:
    """
    cfg = {
      "authors": "*" | {match} | [{match},...],
      "mode": "replace" | "merge",     # default: replace for provided keys
      "set": { ... },                  # institutions/affiliations/raw_affiliation_strings/...
      "unset": ["countries"]           # optional
    }
    """
    if not isinstance(authorships, list) or not isinstance(cfg, dict):
        return
    mode = (cfg.get("mode") or "replace").lower()
    to_set = cfg.get("set") or {}
    to_unset = cfg.get("unset") or []

    for auth in authorships:
        if not _any_author_match(auth, cfg.get("authors")):
            continue

        # optional unsets
        for f in to_unset:
            auth.pop(f, None)

        if mode == "replace":
            # replace only provided keys (not whole authorship)
            for k, v in to_set.items():
                auth[k] = v
        else:
            deep_merge(auth, to_set)


# -----------------------
# main entry point
# -----------------------

def apply_work_patches(works_by_id: Dict[str, dict], patches: dict) -> Set[str]:
    """
    Apply patches to works in-place.

    Returns:
        Set[str]: work IDs for which raw affiliation strings must be ignored downstream.
    """
    disable_raw: Set[str] = set()
    if not isinstance(works_by_id, dict) or not works_by_id:
        return disable_raw

    work_patches = (patches or {}).get("works", {})
    if not isinstance(work_patches, dict) or not work_patches:
        return disable_raw

    doi_index = _index_by_doi(works_by_id)

    for key, patch in work_patches.items():
        if not isinstance(patch, dict):
            continue

        # Locate target by OpenAlex ID first, then DOI
        target = works_by_id.get(key)
        if target is None:
            target = doi_index.get(_normalize_doi(key))
        if target is None:
            continue  # silently skip unknown keys

        # mark for raw disabling
        if patch.get("disable_raw_affiliations"):
            if isinstance(target.get("id"), str):
                disable_raw.add(target["id"])

        # optional work-level overrides
        overrides = patch.get("work_overrides")
        if isinstance(overrides, dict):
            mode = (patch.get("mode") or "merge").lower()
            if mode == "replace":
                # Replace only provided keys (not the full work object)
                for k, v in overrides.items():
                    target[k] = v
            else:
                deep_merge(target, overrides)

        # --- batch operations (optional) ---
        if isinstance(target.get("authorships"), list):
            # remove_institutions_for_authors: accept single dict or list of dicts (optional)
            rm_cfg = patch.get("remove_institutions_for_authors")
            if isinstance(rm_cfg, dict):
                _batch_remove_institutions(target["authorships"], rm_cfg)
            elif isinstance(rm_cfg, list):
                for cfg in rm_cfg:
                    if isinstance(cfg, dict):
                        _batch_remove_institutions(target["authorships"], cfg)

            # set_affiliation_for_authors: accept single dict or list of dicts (group-wise ops)
            set_cfg = patch.get("set_affiliation_for_authors")
            if isinstance(set_cfg, dict):
                _batch_set_affiliation(target["authorships"], set_cfg)
            elif isinstance(set_cfg, list):
                for cfg in set_cfg:
                    if isinstance(cfg, dict):
                        _batch_set_affiliation(target["authorships"], cfg)
        # --- end batch operations ---

        # per-authorship targeted edits (first match wins)
        edits = patch.get("authorships") or []
        if isinstance(edits, list) and isinstance(target.get("authorships"), list):
            for edit in edits:
                match = edit.get("match") or {}
                for auth in target["authorships"]:
                    if _match_authorship(auth, match):
                        _apply_authorship_edit(auth, edit)
                        break

    return disable_raw


def apply_author_patches(
    works_by_id: Dict[str, dict],
    curated_work_ids: Iterable[str],
    patches: dict,
) -> None:
    """
    Replace duplicate/mis-assigned author IDs within curated works.

    Args:
        works_by_id: Mapping of OpenAlex work IDs to work metadata.
        curated_work_ids: Iterable of work IDs that belong to the local dataset.
        patches: Patch payload (expects an "authors" mapping).
    """
    if not works_by_id or not curated_work_ids:
        return
    author_map_raw = (patches or {}).get("authors")
    if not isinstance(author_map_raw, dict) or not author_map_raw:
        return

    replacements: Dict[str, str] = {}
    for source_id, target_id in author_map_raw.items():
        if not isinstance(source_id, str) or not isinstance(target_id, str):
            continue
        src = source_id.strip()
        dst = target_id.strip()
        if not src or not dst or src == dst:
            continue
        replacements[src] = dst

    if not replacements:
        return

    changes = 0
    for work_id in curated_work_ids:
        work = works_by_id.get(work_id)
        if not isinstance(work, dict):
            continue
        authorships = work.get("authorships")
        if not isinstance(authorships, list):
            continue
        for authorship in authorships:
            author = authorship.get("author")
            if not isinstance(author, dict):
                continue
            current_id = author.get("id")
            replacement = replacements.get(current_id)
            if not replacement:
                continue
            author["id"] = replacement
            changes += 1

    if changes:
        print(f"[patches] author id replacements applied: {changes}")


def get_author_local_overrides(patches: Optional[dict]) -> Dict[str, dict]:
    """
    Normalize author locality overrides.

    Returns mapping:
    {
        "<author_id>": {
            "force_currently_local": Optional[bool],
            "force_local_authorships": {
                "local": bool,
                "since_year": Optional[int],
                "until_year": Optional[int],
            } | None,
        }
    }
    """
    overrides_raw = (patches or {}).get("overwrite")
    if not isinstance(overrides_raw, dict):
        return {}

    result: Dict[str, dict] = {}

    def normalize_year(value: Any) -> Optional[int]:
        if value is None:
            return None
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return int(value)
        try:
            return int(value)
        except Exception:
            return None

    for author_id, cfg in overrides_raw.items():
        if not isinstance(author_id, str) or not isinstance(cfg, dict):
            continue
        record: Dict[str, Any] = {}
        if "force_currently_local" in cfg and isinstance(cfg["force_currently_local"], bool):
            record["force_currently_local"] = cfg["force_currently_local"]

        local_cfg = cfg.get("force_local_authorships")
        if isinstance(local_cfg, dict) and isinstance(local_cfg.get("local"), bool):
            record["force_local_authorships"] = {
                "local": local_cfg["local"],
                "since_year": normalize_year(local_cfg.get("since_year")),
                "until_year": normalize_year(local_cfg.get("until_year")),
            }
        if record:
            result[author_id.strip()] = record

    return result
