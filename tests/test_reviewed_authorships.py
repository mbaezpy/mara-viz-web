import copy
import json
from pathlib import Path

import pytest

from processing.collab_network import build_network_from_lookup
from processing.openalex_patcher import (
    apply_author_patches, apply_work_patches, load_patches,
)
from processing.topics_to_d3 import build_lookup_tables, build_library_datasets


def reviewed_work(short_id):
    path = Path(__file__).resolve().parents[1] / "processing/patches/openalex_patches.json"
    patches = load_patches(path)
    wid = f"https://openalex.org/{short_id}"
    works = {wid: {"id": wid, "display_name": "Reviewed paper", "publication_year": 2018,
                   "cited_by_count": 1, "authorships": []}}
    disabled = apply_work_patches(works, patches)
    apply_author_patches(works, {wid}, patches)
    return wid, works, disabled, patches


def test_external_overrides_resolve_relative_to_patch_file_and_keep_inline_values(tmp_path, monkeypatch):
    folder = tmp_path / "patches"
    folder.mkdir()
    (folder / "authors.json").write_text(json.dumps({"display_name": "File title", "authorships": []}))
    path = folder / "patches.json"
    path.write_text(json.dumps({"works": {"https://openalex.org/W1": {
        "work_overrides_file": "authors.json", "work_overrides": {"display_name": "Inline title"},
    }}}))
    monkeypatch.chdir(tmp_path.parent)
    patches = load_patches(path)
    works = {"https://openalex.org/W1": {"id": "https://openalex.org/W1", "authorships": [{"old": True}]}}
    apply_work_patches(works, patches)
    assert works["https://openalex.org/W1"]["display_name"] == "Inline title"
    assert works["https://openalex.org/W1"]["authorships"] == []


@pytest.mark.parametrize("payload", [None, "invalid-json", "[]"])
def test_external_override_errors_are_not_silently_ignored(tmp_path, payload):
    path = tmp_path / "patches.json"
    path.write_text(json.dumps({"works": {"https://openalex.org/W1": {"work_overrides_file": "authors.json"}}}))
    if payload is not None:
        (tmp_path / "authors.json").write_text(payload)
    with pytest.raises(ValueError, match="authors.json"):
        load_patches(path)


@pytest.mark.parametrize("short_id,byline_count,people_count,first_names,last_names", [
    ("W7140298212", 44, 296, {"Sumanta Barman", "Saskia Jania Räuber", "Katharina Eisenhut"},
     {"Franziska Thaler", "Nico Melzer"}),
    ("W7128793906", 33, 224, {"Jonathan Wickel"}, {"Christian Geis"}),
    ("W4392047307", 32, 208, {"Patrik Greguletz", "Maria Plötz"}, {"Kathrin Doppler"}),
])
def test_pdf_reviewed_patches_preserve_groups_without_duplicate_counts_or_false_last_authors(
    short_id, byline_count, people_count, first_names, last_names,
):
    patch_path = Path(__file__).resolve().parents[1] / "processing/patches/openalex_patches.json"
    patches = load_patches(patch_path)
    wid = f"https://openalex.org/{short_id}"
    works = {wid: {"id": wid, "display_name": "Reviewed paper", "publication_year": 2026,
                   "cited_by_count": 1, "authorships": []}}
    disabled = apply_work_patches(works, patches)
    apply_author_patches(works, {wid}, patches)
    corrected = copy.deepcopy(works[wid])
    apply_work_patches(works, patches)
    apply_author_patches(works, {wid}, patches)
    assert works[wid] == corrected  # Rebuilding must not add another author entry.
    entries = works[wid]["authorships"]
    assert len(entries) == people_count
    ids = [a["author"]["id"] for a in entries]
    assert len(set(ids)) == len(ids)
    assert len([a for a in entries if a["is_byline_author"]]) == byline_count
    assert [a["author"]["id"] for a in entries if a["is_byline_author"]] == works[wid]["byline_author_ids"]
    assert entries[-1]["main_author"] is False
    assert "https://openalex.org/A5146610494" not in ids  # Collective credit is not a person.
    assert ids.count("https://openalex.org/A5074695558") == 1
    if short_id == "W7128793906":
        assert not set(ids) & {"https://openalex.org/A5006053238", "https://openalex.org/A5083586745",
                              "https://openalex.org/A5015584152"}
    assignments = {wid: {"J"}}
    topics = {"J": {"name": "Autoimmune seizures and epilepsy", "parent": None}}
    papers, authors, journals = build_lookup_tables({wid}, works, assignments, disabled)
    refs = papers[wid]["author_ids"]
    assert len(refs) == people_count
    assert all(not ref["main_author"] for ref in refs if not ref["is_byline_author"])
    library, _ = build_library_datasets(papers, authors, journals, assignments, topics, works)
    assert len(library) == 1
    assert len(library[0]["authors"]) == people_count
    assert sum(a["is_byline_author"] for a in library[0]["authors"]) == byline_count
    network_authors, edges, _ = build_network_from_lookup(papers, authors)
    assert len(network_authors) == people_count
    assert all(source != target for source, target in edges)
    assert all(author["pub_count"] == 1 for author in network_authors.values())
    assert {a["name"] for a in network_authors.values() if a["first_pub_total"]} == first_names
    assert {a["name"] for a in network_authors.values() if a["last_pub_total"]} == last_names
    assert all(a["last_pub_total"] == 0 for aid, a in network_authors.items()
               if aid not in works[wid]["byline_author_ids"])


def test_hyponatremia_keeps_the_two_biens_as_distinct_people_with_correct_affiliations():
    wid, works, disabled, _ = reviewed_work("W2784071103")
    entries = works[wid]["authorships"]
    assert len(entries) == len({a["author"]["id"] for a in entries}) == 5
    professor, corinna = entries[2:4]
    assert professor["raw_author_name"] == "C. G. Bien"
    assert professor["author"]["id"] == "https://openalex.org/A5074695558"
    assert professor["author"]["orcid"] == "https://orcid.org/0000-0003-2225-8654"
    assert corinna["raw_author_name"] == "C. Bien"
    assert corinna["author"]["id"] == "https://openalex.org/A5104067696"
    assert corinna["author"]["display_name"] == "Corinna Bien"
    assert corinna["author"]["orcid"] is None
    assert corinna["raw_orcid"] is None
    assert {i["id"] for i in professor["institutions"]} == {
        "https://openalex.org/I4387154539", "https://openalex.org/I4210134799",
    }
    assert [i["id"] for i in corinna["institutions"]] == ["https://openalex.org/I4210134799"]
    assert len(corinna["raw_affiliation_strings"]) == 1
    assignments = {wid: {"J"}}
    papers, authors, journals = build_lookup_tables({wid}, works, assignments, disabled)
    refs = {a["id"]: a for a in papers[wid]["author_ids"]}
    assert refs[professor["author"]["id"]]["local"] is True
    assert refs[corinna["author"]["id"]]["local"] is False
    network_authors, edges, _ = build_network_from_lookup(papers, authors)
    assert len(network_authors) == 5 and len(edges) == 4
    assert all(a != b for a, b in edges)
    assert all(a["pub_count"] == 1 for a in network_authors.values())
    assert network_authors[corinna["author"]["id"]]["is_local"] is False


def test_everolimus_retains_investigators_and_corrects_shared_affiliations_and_ikeda_identity():
    wid, works, disabled, patches = reviewed_work("W2894432237")
    entries = works[wid]["authorships"]
    assert len(entries) == len({a["author"]["id"] for a in entries}) == 113
    assert sum(a["is_byline_author"] for a in entries) == 14
    assert sum("study_group_member" in a["authorship_roles"] for a in entries) == 104
    assert sum(not a["is_byline_author"] for a in entries) == 99
    assert sum(len(a["authorship_roles"]) == 2 for a in entries) == 5
    ikeda = [a for a in entries if a["author"]["display_name"] == "Hiroko Ikeda"]
    assert len(ikeda) == 1
    assert ikeda[0]["author"]["id"] == "https://openalex.org/A5102864263"
    assert ikeda[0]["author"]["orcid"] != "https://orcid.org/0000-0002-7278-7282"
    assert all(a["author"]["id"] != "https://openalex.org/A5025226768" for a in entries)
    assert "https://openalex.org/A5025226768" not in patches.get("authors", {})  # This is not a global merge.
    assert entries[0]["countries"] == ["US"]
    assert [i["id"] for i in entries[0]["institutions"]] == ["https://openalex.org/I1285204247"]
    polster = next(a for a in entries if a["author"]["id"] == "https://openalex.org/A5042463561")
    assert polster["countries"] == ["DE"]
    assert [i["id"] for i in polster["institutions"]] == ["https://openalex.org/I4387154539"]
    assert entries[13]["author_position"] == "last"
    assert entries[-1]["main_author"] is False
    assignments = {wid: {"C"}}
    topics = {"C": {"name": "Pharmacology", "parent": None}}
    papers, authors, journals = build_lookup_tables({wid}, works, assignments, disabled)
    assert [a["id"] for a in papers[wid]["author_ids"] if a["local"]] == [polster["author"]["id"]]
    library, _ = build_library_datasets(papers, authors, journals, assignments, topics, works)
    assert len(library[0]["authors"]) == 113
    network_authors, edges, _ = build_network_from_lookup(papers, authors)
    assert all(a["pub_count"] == 1 for a in network_authors.values())
    assert all(source != target for source, target in edges)
    assert {a["name"] for a in network_authors.values() if a["first_pub_total"]} == {"David Neal Franz"}
    assert {a["name"] for a in network_authors.values() if a["last_pub_total"]} == {"Jacqueline A. French"}


def test_caspr2_preserves_every_credit_and_uses_published_byline_affiliations():
    wid, works, disabled, patches = reviewed_work("W4392047307")
    work = works[wid]
    entries = work["authorships"]
    byid = {a["author"]["id"]: a for a in entries}
    assert len(byid) == len(entries) == 208
    assert sum(a["is_byline_author"] for a in entries) == 32
    assert sum(not a["is_byline_author"] for a in entries) == 176
    members = [a for a in entries if "study_group_member" in a["authorship_roles"]]
    assert len(members) == 181
    assert sorted(a["study_group_credit"]["position"] for a in members) == list(range(1, 182))
    assert sum(len(a["authorship_roles"]) == 2 for a in entries) == 5
    felix = byid["https://openalex.org/A5012495517"]
    assert set(felix["raw_author_names"]) == {"Felix von Podewils", "Felix von Poderwils"}
    assert felix["study_group_credit"]["published_name"] == "Felix von Poderwils"
    assert "https://openalex.org/A5093979156" not in byid
    assert "https://openalex.org/A5093979156" not in patches.get("authors", {})
    assert "https://openalex.org/A5083586745" not in byid
    assert byid["https://openalex.org/A5109784153"]["raw_author_name"] == "Mosche Pompsch"
    professor = byid["https://openalex.org/A5074695558"]
    corinna = byid["https://openalex.org/A5104067696"]
    anna = byid["https://openalex.org/A5034647334"]
    assert {i["id"] for i in professor["institutions"]} == {
        "https://openalex.org/I4387154539", "https://openalex.org/I20121455", "https://openalex.org/I4210134799",
    }
    assert {i["id"] for i in anna["institutions"]} == {
        "https://openalex.org/I4387154539", "https://openalex.org/I20121455",
    }
    assert [i["id"] for i in corinna["institutions"]] == ["https://openalex.org/I4210134799"]
    assert corinna["author"]["orcid"] is None
    assert [i["id"] for i in byid["https://openalex.org/A5031549553"]["institutions"]] == [
        "https://openalex.org/I4210103666",
    ]  # The cache's group entry must not add Freiburg to the published Münster affiliation.
    assert len(byid["https://openalex.org/A5071465493"]["raw_affiliation_strings"]) == 2
    assert len(byid["https://openalex.org/A5038126368"]["raw_affiliation_strings"]) == 3
    assert any(i["id"] is None and i["display_name"] == "Hospital Murtal, Knittelfeld"
               for i in byid["https://openalex.org/A5103089497"]["institutions"])
    assert entries[0]["equal_contribution_group"] == entries[1]["equal_contribution_group"] == 1
    assert [a["author"]["id"] for a in entries if a["is_corresponding"]] == [entries[31]["author"]["id"]]
    assignments = {wid: {"J"}}
    papers, authors, _ = build_lookup_tables({wid}, works, assignments, disabled)
    refs = {a["id"]: a for a in papers[wid]["author_ids"]}
    assert refs[professor["author"]["id"]]["local"]
    assert refs[anna["author"]["id"]]["local"]
    assert not refs[corinna["author"]["id"]]["local"]
