import json
from pathlib import Path

import pytest
import requests

from processing import pipeline
from processing.csv_io import read_csv
from processing.paper_retrieve import retrieve
from processing.topics_to_d3 import normalize_doi, normalize_openalex_id


def write_json(path, data):
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def work(wid="W1", doi="10.1234/test", refs=None):
    return {
        "id": f"https://openalex.org/{wid}", "doi": f"https://doi.org/{doi}",
        "display_name": "A study", "publication_year": 2026,
        "publication_date": "2026-01-01", "cited_by_count": 3,
        "referenced_works": refs or [],
        "authorships": [
            {"author": {"id": "https://openalex.org/A1", "display_name": "Local"},
             "author_position": "first", "institutions": [
                 {"id": "https://openalex.org/I4387154539", "display_name": "Klinik Mara", "country_code": "DE"}]},
            {"author": {"id": "https://openalex.org/A2", "display_name": "External"},
             "author_position": "last", "institutions": [
                 {"id": "https://openalex.org/I2", "display_name": "External university", "country_code": "GB"}]},
        ],
    }


class Session:
    def __init__(self, works):
        self.works = iter(works)
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append(url)
        result = next(self.works)
        if isinstance(result, Exception):
            raise result

        class Response:
            def raise_for_status(self):
                pass

            def json(self):
                return result

        return Response()


@pytest.fixture
def dataset(tmp_path):
    publications = tmp_path / "publications.csv"
    publications.write_text("DOI;Title;final_topics\n10.1234/test;A study;A.1\n", encoding="utf-8")
    topics = tmp_path / "topics.csv"
    topics.write_text("topic_id;topic_name;parent_topic\nA;Root;\nA.1;Child;A\n", encoding="utf-8")
    cache = write_json(tmp_path / "cache.json", [work()])
    patches = write_json(tmp_path / "patches.json", {})
    return publications, topics, cache, patches


def test_csv_windows_encoding_and_quoted_multiline_title(tmp_path):
    path = tmp_path / "export.csv"
    path.write_bytes('DOI;Title;final_topics\n10.1234/test;"Müller; a\nnew study";A\n'.encode("cp1252"))
    assert read_csv(path, required=("DOI",))[0]["Title"] == "Müller; a\nnew study"


@pytest.mark.parametrize("identifier,expected", [
    ("w123", "https://openalex.org/W123"),
    ("http://openalex.org/w123", "https://openalex.org/W123"),
    ("10.1212/WNL.0000000000001072", ""),
    ("https://doi.org/10.1212/WCO.0000000000000909", ""),
    ("https://example.org/W123", ""),
])
def test_openalex_identifier_does_not_mistake_doi_suffix_for_work_id(identifier, expected):
    assert normalize_openalex_id(identifier) == expected


def test_doi_normalizes_excel_artifact():
    assert normalize_doi("https://doi.org/10.1234/ABCÂ\xa0") == "10.1234/abc"


def test_retrieval_reuses_cache_normalizes_dois_and_resumes(dataset):
    publications, _, cache, patches = dataset
    publications.write_text(
        "DOI;Title;final_topics\nhttps://doi.org/10.1234/TEST;Cached;A\n"
        "10.1234/new;New;A\n10.1234/new;Duplicate;A\n", encoding="utf-8")
    session = Session([work("W2", "10.1234/new", refs=["https://openalex.org/W3"])])
    first = retrieve(publications, cache, patches, delay=0, session=session)
    assert first["cached"] == 1
    assert first["downloaded"] == 1
    assert len(session.calls) == 1  # References are not downloaded by default.
    second = retrieve(publications, cache, patches, delay=0, session=Session([]))
    assert second["cached"] == 2 and second["downloaded"] == 0
    assert len(json.loads(cache.read_text())) == 2


def test_optional_references_include_those_of_cached_works(dataset):
    publications, _, cache, patches = dataset
    write_json(cache, [work(refs=["https://openalex.org/W2"])])
    result = retrieve(publications, cache, patches, delay=0, with_references=True,
                      session=Session([work("W2", "10.1234/ref")]))
    assert result["cached"] == 1 and result["downloaded"] == 1


def test_failure_preserves_progress_for_retry(dataset):
    publications, _, cache, patches = dataset
    publications.write_text("DOI\n10.1234/new\n10.1234/fail\n", encoding="utf-8")
    result = retrieve(publications, cache, patches, delay=0,
                      session=Session([work("W2", "10.1234/new"), requests.Timeout()]))
    assert result["failed"] == [{"identifier": "10.1234/fail", "error": "Timeout"}]
    assert len(json.loads(cache.read_text())) == 2


def test_authentication_failure_stops_requests_and_saves_progress(dataset, tmp_path):
    publications, _, cache, patches = dataset
    publications.write_text("DOI\n10.1234/new\n10.1234/blocked\n10.1234/later\n", encoding="utf-8")
    response = requests.Response()
    response.status_code = 403
    session = Session([work("W2", "10.1234/new"), requests.HTTPError(response=response)])
    report_path = tmp_path / "report.json"
    with pytest.raises(RuntimeError, match="HTTP 403"):
        retrieve(publications, cache, patches, delay=0, session=session, report_path=report_path)
    assert len(session.calls) == 2
    assert len(json.loads(cache.read_text())) == 2
    assert json.loads(report_path.read_text())["failed"][0]["error"] == "HTTP 403"


def test_check_uses_included_patched_work_by_doi(dataset):
    publications, topics, cache, patches = dataset
    write_json(cache, [])
    write_json(patches.parent / "included.json", work())
    write_json(patches, {"include": ["included.json"]})
    report = pipeline.check(publications, topics, cache, patches)
    assert report["missing_metadata"] == []
    result = retrieve(publications, cache, patches, delay=0, session=Session([]))
    assert result["cached"] == 1


def test_fetch_defaults_to_reference_without_requiring_topics(dataset, tmp_path, monkeypatch):
    _, _, cache, patches = dataset
    reference = tmp_path / "download_reference.csv"
    reference.write_text("DOI\n10.1234/test\n", encoding="utf-8")
    monkeypatch.setattr(pipeline, "DEFAULT_INPUT", reference)
    monkeypatch.setattr(pipeline, "HERE", tmp_path)
    assert pipeline.main(["fetch", "--cache", str(cache), "--patches", str(patches)]) == 0
    result = json.loads((tmp_path / "runs/download_reference/retrieval.json").read_text())
    assert result["cached"] == 1 and result["downloaded"] == 0


def test_check_and_build_default_to_manual_tagged_file(dataset, tmp_path, monkeypatch):
    publications, topics, cache, patches = dataset
    reference = tmp_path / "download_reference.csv"
    reference.write_text("DOI\n10.1234/not-yet-tagged\n", encoding="utf-8")
    monkeypatch.setattr(pipeline, "DEFAULT_INPUT", reference)
    monkeypatch.setattr(pipeline, "DEFAULT_TAGGED", publications)
    monkeypatch.setattr(pipeline, "HERE", tmp_path)
    options = ["--topics-csv", str(topics), "--cache", str(cache), "--patches", str(patches)]
    assert pipeline.main(["check"] + options) == 0
    assert pipeline.main(["build"] + options) == 0
    lookup = json.loads((tmp_path / "runs/publications/data/topics_lookup.json").read_text())
    assert list(lookup["papers"]) == ["https://openalex.org/W1"]
    assert reference.read_text() == "DOI\n10.1234/not-yet-tagged\n"


def test_build_refuses_unknown_or_missing_manual_topics(dataset, tmp_path, monkeypatch):
    publications, topics, cache, patches = dataset
    publications.write_text("DOI;Title;final_topics\n10.1234/test;Study;\n", encoding="utf-8")
    monkeypatch.setattr(pipeline, "HERE", tmp_path)
    destination = tmp_path / "output"
    args = ["build", str(publications), "--topics-csv", str(topics),
            "--cache", str(cache), "--patches", str(patches), "--output-dir", str(destination)]
    assert pipeline.main(args) == 1
    assert not destination.exists()
    publications.write_text("DOI;Title;final_topics\n10.1234/test;Study;TYPO\n", encoding="utf-8")
    assert pipeline.main(args + ["--allow-untagged"]) == 1
    assert not destination.exists()


@pytest.mark.parametrize("command", ["check", "build"])
def test_validation_identifies_unknown_topic_and_exports_details(dataset, tmp_path, monkeypatch, capsys, command):
    publications, topics, cache, patches = dataset
    publications.write_text(
        'DOI;Title;final_topics\n10.1234/test;"A study; with details";A.1,A.9\n', encoding="utf-8")
    original = publications.read_bytes()
    monkeypatch.setattr(pipeline, "HERE", tmp_path)
    destination = tmp_path / "output"
    options = [str(publications), "--topics-csv", str(topics), "--cache", str(cache),
               "--patches", str(patches), "--output-dir", str(destination)]
    assert pipeline.main([command] + options) == 1
    output = capsys.readouterr().out
    assert "CSV row 2: A study; with details" in output
    assert "DOI / OpenAlex ID: 10.1234/test" in output
    assert "final_topics: 'A.1,A.9'" in output
    assert "Unknown topic ID: 'A.9' is not defined in" in output
    assert "Related defined topics (reference only):" in output
    assert "A.1: Child" in output
    assert "Recognized assignments: A.1: Child" in output
    assert str(topics) in output
    run_dir = tmp_path / "runs/publications"
    assert str(run_dir / "validation_issues.csv") in output
    report = read_csv(run_dir / "validation_issues.csv")
    assert len(report) == 1
    assert report[0]["issue"] == "unknown_topics"
    assert report[0]["row"] == "2" and report[0]["Title"] == "A study; with details"
    assert report[0]["details"] == "Unknown topic IDs: A.9"
    assert report[0]["final_topics"] == "A.1,A.9"
    assert publications.read_bytes() == original  # Inspection never changes tags.
    assert not destination.exists()
    publications.write_text("DOI;Title;final_topics\n10.1234/test;A study;A.1\n", encoding="utf-8")
    assert pipeline.main(["check"] + options) == 0
    assert read_csv(run_dir / "validation_issues.csv") == []  # Resolved issues disappear.


def test_validation_lists_missing_topics_identifiers_metadata_and_duplicate_origin(dataset, tmp_path, monkeypatch, capsys):
    publications, topics, cache, patches = dataset
    publications.write_text(
        "DOI;Title;final_topics\n10.1234/test;Needs topics;\n"
        ";Needs identifier;A.1\n10.1234/not-cached;Needs metadata;A.1\n"
        "10.1234/TEST;Repeated publication;A.1\n", encoding="utf-8")
    monkeypatch.setattr(pipeline, "HERE", tmp_path)
    assert pipeline.main(["check", str(publications), "--topics-csv", str(topics),
                          "--cache", str(cache), "--patches", str(patches)]) == 1
    output = capsys.readouterr().out
    for row, title in [(2, "Needs topics"), (3, "Needs identifier"), (4, "Needs metadata"), (5, "Repeated publication")]:
        assert f"CSV row {row}: {title}" in output
    assert "(missing identifier)" in output
    assert "Also appears at CSV row 2" in output
    issues = read_csv(tmp_path / "runs/publications/validation_issues.csv")
    assert {item["issue"] for item in issues} == {"untagged", "missing_identifiers", "missing_metadata", "duplicates"}
    duplicate = next(item for item in issues if item["issue"] == "duplicates")
    assert duplicate["severity"] == "warning"
    assert "CSV row 2" in duplicate["details"]


def test_build_generates_all_web_datasets_in_selected_directory(dataset, tmp_path, monkeypatch):
    publications, topics, cache, patches = dataset
    monkeypatch.setattr(pipeline, "HERE", tmp_path)
    destination = tmp_path / "preview"
    assert pipeline.main(["build", str(publications), "--topics-csv", str(topics),
                          "--cache", str(cache), "--patches", str(patches),
                          "--output-dir", str(destination)]) == 0
    expected = {"topics_hierarchy.json", "topics_lookup.json", "library_publications.json",
                "library_authors.json", "reports.json", "oa_coauth.json", "oa_coauth.graphml",
                "oa_coauth.gexf", "oa_coauth_vos_map.tsv", "oa_coauth_vos_network.tsv"}
    assert {p.name for p in destination.iterdir()} == expected
    lookup = json.loads((destination / "topics_lookup.json").read_text())
    assert list(lookup["papers"]) == ["https://openalex.org/W1"]
    network = json.loads((destination / "oa_coauth.json").read_text())
    assert len(network["nodes"]) == 2
    assert len(network["links"]) == 1
