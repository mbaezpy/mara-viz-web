# tests/test_openalex_patcher.py
import json
from pathlib import Path
import pytest

# import the module under test
import processing.openalex_patcher as mod


# ---------- helpers ----------

def mk_work(
    wid="https://openalex.org/W123",
    doi="10.1000/xyz",
    authors=None,
    extra=None,
):
    work = {
        "id": wid,
        "doi": f"https://doi.org/{doi}",
        "ids": {"doi": f"https://doi.org/{doi}", "openalex": wid},
        "display_name": "Test Work",
        "authorships": authors if authors is not None else [
            {
                "author_position": "first",
                "author": {
                    "id": "https://openalex.org/A1",
                    "display_name": "Alice",
                    "orcid": "https://orcid.org/0000-0000-0000-0001",
                },
                "institutions": [
                    {"id": "https://openalex.org/I1", "display_name": "Inst 1", "ror": "https://ror.org/01"}
                ],
                "raw_affiliation_strings": ["Alice Raw, Inst 1; Dept X"],
                "countries": ["DE"],
            },
            {
                "author_position": "middle",
                "author": {
                    "id": "https://openalex.org/A2",
                    "display_name": "Bob",
                    "orcid": "https://orcid.org/0000-0000-0000-0002",
                },
                "institutions": [
                    {"id": "https://openalex.org/I2", "display_name": "Inst 2", "ror": "https://ror.org/02"}
                ],
                "raw_affiliation_strings": ["Bob Raw, Inst 2"],
                "countries": ["DK"],
            },
        ],
    }
    if extra:
        work.update(extra)
    return work


# ---------- tests: load_patches ----------

def test_load_patches_missing_file(tmp_path: Path):
    path = tmp_path / "nope.json"
    data = mod.load_patches(path)
    assert isinstance(data, dict)
    assert data.get("works") == {}


def test_load_patches_malformed_json(tmp_path: Path):
    path = tmp_path / "bad.json"
    path.write_text("{not json", encoding="utf-8")
    data = mod.load_patches(path)
    assert data.get("works") == {}


def test_load_patches_ok(tmp_path: Path):
    path = tmp_path / "ok.json"
    payload = {"works": {"https://openalex.org/Wx": {}}}
    path.write_text(json.dumps(payload), encoding="utf-8")
    data = mod.load_patches(path)
    assert data == payload


# ---------- tests: apply_work_patches (ID vs DOI lookup) ----------

@pytest.mark.parametrize("key_is", ["id", "doi"])
def test_apply_work_patches_resolves_by_id_or_doi(tmp_path: Path, key_is):
    w = mk_work(wid="https://openalex.org/WID", doi="10.1/abc")
    works_by_id = {w["id"]: w}

    key = w["id"] if key_is == "id" else "10.1/abc"  # normalized DOI key allowed
    patches = {
        "works": {
            key: {
                "work_overrides": {"display_name": "Patched Title"}
            }
        }
    }
    disabled = mod.apply_work_patches(works_by_id, patches)
    assert works_by_id[w["id"]]["display_name"] == "Patched Title"
    assert disabled == set()


# ---------- tests: work_overrides merge vs replace ----------

def test_work_overrides_merge():
    w = mk_work(extra={"nested": {"a": 1, "b": 2}})
    works_by_id = {w["id"]: w}
    patches = {
        "works": {
            w["id"]: {
                "mode": "merge",
                "work_overrides": {"nested": {"b": 99, "c": 3}}
            }
        }
    }
    mod.apply_work_patches(works_by_id, patches)
    assert works_by_id[w["id"]]["nested"] == {"a": 1, "b": 99, "c": 3}


def test_work_overrides_replace():
    w = mk_work(extra={"nested": {"a": 1, "b": 2}})
    works_by_id = {w["id"]: w}
    patches = {
        "works": {
            w["id"]: {
                "mode": "replace",
                "work_overrides": {"nested": {"x": 42}}
            }
        }
    }
    mod.apply_work_patches(works_by_id, patches)
    # replace affects only provided keys (not the entire work object),
    # but fully replaces the value of 'nested'
    assert works_by_id[w["id"]]["nested"] == {"x": 42}


# ---------- tests: authorship edits (merge/replace/unset) ----------

def test_authorship_edit_merge_and_unset():
    w = mk_work()
    works_by_id = {w["id"]: w}
    patches = {
        "works": {
            w["id"]: {
                "authorships": [
                    {
                        "match": {"author_id": "https://openalex.org/A1"},
                        "action": "merge",
                        "unset": ["countries"],
                        "set": {
                            "institutions": [
                                {"id": "https://openalex.org/Ix", "display_name": "New Inst", "ror": "https://ror.org/xx"}
                            ],
                            "extra_field": {"note": "added"},
                        },
                    }
                ]
            }
        }
    }
    mod.apply_work_patches(works_by_id, patches)
    a1 = next(a for a in works_by_id[w["id"]]["authorships"] if a["author"]["id"] == "https://openalex.org/A1")
    assert "countries" not in a1
    assert a1["institutions"][0]["display_name"] == "New Inst"
    assert a1["extra_field"]["note"] == "added"


def test_authorship_edit_replace_only_replaces_given_keys():
    w = mk_work()
    works_by_id = {w["id"]: w}
    before = next(a for a in w["authorships"] if a["author"]["id"] == "https://openalex.org/A2")
    assert "raw_affiliation_strings" in before

    patches = {
        "works": {
            w["id"]: {
                "authorships": [
                    {
                        "match": {"orcid": "https://orcid.org/0000-0000-0000-0002"},
                        "action": "replace",
                        "set": {
                            "raw_affiliation_strings": ["Cleaned Affil"],
                        },
                    }
                ]
            }
        }
    }
    mod.apply_work_patches(works_by_id, patches)
    a2 = next(a for a in works_by_id[w["id"]]["authorships"] if a["author"]["id"] == "https://openalex.org/A2")
    assert a2["raw_affiliation_strings"] == ["Cleaned Affil"]
    # Other keys remain
    assert a2["author"]["display_name"] == "Bob"


# ---------- tests: disable_raw_affiliations ----------

def test_disable_raw_affiliations_returns_work_ids():
    w1 = mk_work(wid="https://openalex.org/W1", doi="10.9/a")
    w2 = mk_work(wid="https://openalex.org/W2", doi="10.9/b")
    works_by_id = {w1["id"]: w1, w2["id"]: w2}

    patches = {
        "works": {
            w1["id"]: {"disable_raw_affiliations": True},
            "10.9/b":  {"disable_raw_affiliations": True},  # via DOI key
        }
    }
    disabled = mod.apply_work_patches(works_by_id, patches)
    assert disabled == {w1["id"], w2["id"]}


# ---------- tests: deep_merge semantics ----------

def test_deep_merge_dicts_and_replace_lists():
    dst = {"a": {"b": 1, "c": [1, 2]}, "x": 1}
    src = {"a": {"c": [9], "d": 4}, "y": 2}
    out = mod.deep_merge(dst, src)
    # dicts merge, lists replace
    assert out["a"]["b"] == 1
    assert out["a"]["c"] == [9]
    assert out["a"]["d"] == 4
    assert out["x"] == 1
    assert out["y"] == 2


# ---------- tests: authorship matching precedence ----------

@pytest.mark.parametrize(
    "match_key,match_val",
    [
        ("author_id", "https://openalex.org/A1"),
        ("orcid", "https://orcid.org/0000-0000-0000-0001"),
        ("display_name", "Alice"),
    ],
)
def test_authorship_matching_by_id_orcid_display_name(match_key, match_val):
    w = mk_work()
    works_by_id = {w["id"]: w}
    patches = {
        "works": {
            w["id"]: {
                "authorships": [
                    {"match": {match_key: match_val}, "set": {"extra_flag": True}}
                ]
            }
        }
    }
    mod.apply_work_patches(works_by_id, patches)
    a1 = next(a for a in works_by_id[w["id"]]["authorships"] if a["author"]["id"] == "https://openalex.org/A1")
    assert a1["extra_flag"] is True


# ---------- NEW: selective removals on a single authorship ----------

def test_authorship_remove_institutions():
    # Add extra institution to A2 so we can remove one of them
    authors = [
        {
            "author_position": "first",
            "author": {"id": "https://openalex.org/A1", "display_name": "Alice"},
            "institutions": [{"id": "https://openalex.org/I1", "display_name": "Inst 1"}],
        },
        {
            "author_position": "middle",
            "author": {"id": "https://openalex.org/A2", "display_name": "Bob"},
            "institutions": [
                {"id": "https://openalex.org/I2", "display_name": "Inst 2"},
                {"id": "https://openalex.org/Ix", "display_name": "Klinik Mara"},
            ],
        },
    ]
    w = mk_work(authors=authors)
    works_by_id = {w["id"]: w}
    patches = {
        "works": {
            w["id"]: {
                "authorships": [
                    {
                        "match": {"author_id": "https://openalex.org/A2"},
                        "remove_institutions": [{"id": "https://openalex.org/Ix"}],
                    }
                ]
            }
        }
    }
    mod.apply_work_patches(works_by_id, patches)
    a2 = next(a for a in works_by_id[w["id"]]["authorships"] if a["author"]["id"] == "https://openalex.org/A2")
    inst_ids = [i.get("id") for i in a2.get("institutions", [])]
    assert "https://openalex.org/Ix" not in inst_ids
    assert "https://openalex.org/I2" in inst_ids


def test_authorship_remove_affiliations_and_raws():
    # A1 with affiliations[] + raw strings we want to clean
    authors = [
        {
            "author_position": "first",
            "author": {"id": "https://openalex.org/A1", "display_name": "Alice"},
            "institutions": [{"id": "https://openalex.org/I1", "display_name": "Inst 1"}],
            "affiliations": [
                {
                    "raw_affiliation_string": "Bad Raw Text A",
                    "institution_ids": ["https://openalex.org/I1", "https://openalex.org/Ix"],
                },
                {
                    "raw_affiliation_string": "Keep Me",
                    "institution_ids": ["https://openalex.org/I1"],
                },
            ],
            "raw_affiliation_strings": ["Bad Raw Text A", "Keep Me Too"],
        }
    ]
    w = mk_work(authors=authors)
    works_by_id = {w["id"]: w}
    patches = {
        "works": {
            w["id"]: {
                "authorships": [
                    {
                        "match": {"author_id": "https://openalex.org/A1"},
                        "remove_affiliations": [
                            {"raw_affiliation_string": "Bad Raw Text A"},
                            {"institution_id": "https://openalex.org/Ix"},
                        ],
                        "remove_raw_affiliation_strings": ["Bad Raw Text A"],
                    }
                ]
            }
        }
    }
    mod.apply_work_patches(works_by_id, patches)
    a1 = works_by_id[w["id"]]["authorships"][0]
    # affiliations[] pruned: only "Keep Me" stays
    assert len(a1.get("affiliations", [])) == 1
    assert a1["affiliations"][0]["raw_affiliation_string"] == "Keep Me"
    # raw_affiliation_strings[] pruned
    assert a1["raw_affiliation_strings"] == ["Keep Me Too"]


# ---------- NEW: batch remove institutions across multiple authors ----------

def test_batch_remove_institutions_for_authors():
    # A1 and A2 both have I999 plus one unique
    authors = [
        {
            "author_position": "first",
            "author": {"id": "https://openalex.org/A1", "display_name": "Alice"},
            "institutions": [
                {"id": "https://openalex.org/I999", "display_name": "Klinik Mara"},
                {"id": "https://openalex.org/I1", "display_name": "Inst 1"},
            ],
        },
        {
            "author_position": "middle",
            "author": {"id": "https://openalex.org/A2", "display_name": "Bob"},
            "institutions": [
                {"id": "https://openalex.org/I999", "display_name": "Klinik Mara"},
                {"id": "https://openalex.org/I2", "display_name": "Inst 2"},
            ],
        },
    ]
    w = mk_work(authors=authors, wid="https://openalex.org/WBATCH")
    works_by_id = {w["id"]: w}

    patches = {
        "works": {
            w["id"]: {
                "remove_institutions_for_authors": {
                    "authors": [
                        {"author_id": "https://openalex.org/A1"},
                        {"author_id": "https://openalex.org/A2"}
                    ],
                    "by": [{"id": "https://openalex.org/I999"}]
                }
            }
        }
    }
    mod.apply_work_patches(works_by_id, patches)

    a1 = next(a for a in works_by_id[w["id"]]["authorships"] if a["author"]["id"] == "https://openalex.org/A1")
    a2 = next(a for a in works_by_id[w["id"]]["authorships"] if a["author"]["id"] == "https://openalex.org/A2")
    assert all(inst["id"] != "https://openalex.org/I999" for inst in a1["institutions"])
    assert all(inst["id"] != "https://openalex.org/I999" for inst in a2["institutions"])
    # unique institutions remain
    assert {i["id"] for i in a1["institutions"]} == {"https://openalex.org/I1"}
    assert {i["id"] for i in a2["institutions"]} == {"https://openalex.org/I2"}


# ---------- NEW: batch set affiliations for selected authors ----------

def test_batch_set_affiliation_for_authors_replace():
    # A2 starts with Inst 2; we will replace it by Klinik Mara
    w = mk_work()
    works_by_id = {w["id"]: w}

    patches = {
        "works": {
            w["id"]: {
                "set_affiliation_for_authors": {
                    "authors": [{"author_id": "https://openalex.org/A2"}],
                    "mode": "replace",
                    "unset": ["countries"],
                    "set": {
                        "institutions": [
                            {
                                "id": "https://openalex.org/I4210104779",
                                "display_name": "Klinik Mara (EvKB Bethel)",
                                "ror": "https://ror.org/0162saw54",
                            }
                        ],
                        "raw_affiliation_strings": [
                            "Department of Epileptology, Klinik Mara (EvKB Bethel), Bielefeld, Germany"
                        ],
                        "affiliations": [
                            {
                                "raw_affiliation_string": "Department of Epileptology, Klinik Mara (EvKB Bethel), Bielefeld, Germany",
                                "institution_ids": ["https://openalex.org/I4210104779"]
                            }
                        ]
                    }
                }
            }
        }
    }

    mod.apply_work_patches(works_by_id, patches)
    a2 = next(a for a in works_by_id[w["id"]]["authorships"] if a["author"]["id"] == "https://openalex.org/A2")
    # institutions replaced
    assert [i["id"] for i in a2["institutions"]] == ["https://openalex.org/I4210104779"]
    # raw strings / affiliations set
    assert a2["raw_affiliation_strings"] == [
        "Department of Epileptology, Klinik Mara (EvKB Bethel), Bielefeld, Germany"
    ]
    assert a2["affiliations"][0]["institution_ids"] == ["https://openalex.org/I4210104779"]
    # unset applied
    assert "countries" not in a2
