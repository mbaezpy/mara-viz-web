import json

import pytest
import requests

from processing.openalex_patcher import apply_work_patches, load_patches
from processing.topics_to_d3 import build_lookup_tables, build_reports_data
from processing.update_stats import stats_fields, update_stats


W1 = "https://openalex.org/W1"
W2 = "https://openalex.org/W2"
STAMP = "2026-11-24T12:00:00+00:00"


def remote(wid=W1, count=12, **extra):
    return {"id": wid, "doi": "https://doi.org/10.1234/test", "cited_by_count": count,
            "counts_by_year": [{"year": 2026, "cited_by_count": count}],
            "updated_date": "2026-11-23T12:00:00", **extra}


class Session:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        item = next(self.responses)
        if isinstance(item, Exception):
            raise item

        class Response:
            def raise_for_status(self):
                pass

            def json(self):
                return item

        return Response()


@pytest.fixture
def files(tmp_path):
    cache = tmp_path / "cache.json"
    cached = {**remote(count=3), "publication_year": 2018, "display_name": "Original title",
              "authorships": [{"author": {"id": "https://openalex.org/A1", "display_name": "Cached author"}}]}
    cache.write_text(json.dumps([cached]))
    csv = tmp_path / "tagged.csv"
    csv.write_text("DOI;Title;final_topics\n10.1234/test;A paper;A\n")
    stats = tmp_path / "stats.json"
    stats.write_text(json.dumps({"schema_version": 1, "works": {}}))
    patch = tmp_path / "patches.json"
    patch.write_text(json.dumps({"stats_file": stats.name, "works": {W1: {"work_overrides": {
        "display_name": "Reviewed title", "cited_by_count": 4,
        "authorships": [{"author": {"id": "https://openalex.org/A2", "display_name": "Reviewed author"}}],
    }}}}))
    return csv, cache, patch, stats, tmp_path / "report.json"


def run(files, session, **kwargs):
    csv, cache, patch, stats, report = files
    return update_stats([csv], cache, patch, stats, report_path=report, session=session, delay=0, **kwargs)


def test_refreshes_cached_works_and_preserves_reviewed_metadata_and_cache(files):
    csv, cache, patch, stats, report_path = files
    before_cache, before_patch = cache.read_bytes(), patch.read_bytes()
    session = Session([{"results": [remote()]}])
    report = run(files, session)
    assert report["complete"] and report["refreshed"] == 1
    assert report["changes"][0]["cached_citations"] == 3
    assert report["changes"][0]["previous_citations"] == 4
    assert report["changes"][0]["current_citations"] == 12
    assert cache.read_bytes() == before_cache and patch.read_bytes() == before_patch
    assert session.calls[0][1]["params"]["filter"] == "ids.openalex:W1"
    assert session.calls[0][1]["params"]["select"] == "id,doi,display_name,publication_year,cited_by_count,counts_by_year,updated_date"
    works = {W1: json.loads(cache.read_text())[0]}
    apply_work_patches(works, load_patches(patch))
    assert works[W1]["display_name"] == "Reviewed title"
    assert works[W1]["authorships"][0]["author"]["display_name"] == "Reviewed author"
    assert works[W1]["cited_by_count"] == 12
    assert works[W1]["updated_date"] == "2026-11-23T12:00:00"
    papers, _, journals = build_lookup_tables({W1}, works, {W1: {"A"}}, set())
    payload = build_reports_data(papers, journals, {"A": {"name": "Root"}}, {W1: {"A"}})
    assert payload["publications"]["total_citations"] == 12
    assert payload["publications"]["years"] == [{"year": 2018, "pubs": 1, "citations": 12, "cum_citations": 12}]
    assert payload["citation_stats"]["refreshed_papers"] == 1


def test_multiple_inputs_deduplicate_and_skip_explicitly_excluded_rows(files, tmp_path):
    csv, cache, patch, stats, report_path = files
    csv.write_text("DOI;final_topics\n10.1234/test;A\n10.1234/excluded;0\n")
    reference = tmp_path / "reference.csv"
    reference.write_text("DOI\nW1\nhttps://doi.org/10.1234/TEST\n")
    session = Session([{"results": [remote()]}])
    report = update_stats([csv, reference], cache, patch, stats, report_path=report_path, session=session, delay=0)
    assert report["requested"] == report["refreshed"] == 1
    assert report["excluded_rows"] == 1
    assert len(report["changes"][0]["input_rows"]) == 3
    assert len(session.calls) == 1


def test_failure_retains_prior_snapshot_and_successful_progress(files):
    csv, cache, patch, stats, report_path = files
    old = stats_fields(remote(W2, 20), STAMP)
    stats.write_text(json.dumps({"schema_version": 1, "works": {W2: old}}))
    records = json.loads(cache.read_text())
    records.append({**records[0], "id": W2, "doi": "https://doi.org/10.1234/other"})
    cache.write_text(json.dumps(records))
    csv.write_text("DOI\nW1\nW2\n")
    response = requests.Response()
    response.status_code = 403
    session = Session([{"results": [remote()]}, requests.HTTPError(response=response)])
    with pytest.raises(RuntimeError, match="HTTP 403"):
        run(files, session, batch_size=1)
    saved = json.loads(stats.read_text())
    assert saved["works"][W1]["cited_by_count"] == 12
    assert saved["works"][W2] == old
    report = json.loads(report_path.read_text())
    assert report["refreshed"] == 1 and not report["complete"]
    assert report["failed"][0]["work_id"] == W2


@pytest.mark.parametrize("fields", [
    {"cited_by_count": None}, {"cited_by_count": -1}, {"cited_by_count": True},
    {"counts_by_year": None},
    {"counts_by_year": [{"year": 2026, "cited_by_count": 1}] * 2},
])
def test_incomplete_or_invalid_responses_do_not_erase_prior_counts(files, fields):
    csv, cache, patch, stats, _ = files
    old = stats_fields(remote(count=20), STAMP)
    stats.write_text(json.dumps({"schema_version": 1, "works": {W1: old}}))
    report = run(files, Session([{"results": [remote(**fields)]}]))
    assert not report["complete"] and report["refreshed"] == 0
    assert json.loads(stats.read_text())["works"][W1] == old


def test_missing_ids_follow_merged_singletons_without_changing_local_identity(files):
    report = run(files, Session([{"results": []}, remote(W2)]))
    assert report["complete"]
    fields = json.loads(files[3].read_text())["works"][W1]
    assert fields["citation_stats_source_work_id"] == W2
    works = {W1: json.loads(files[1].read_text())[0]}
    apply_work_patches(works, load_patches(files[2]))
    assert works[W1]["id"] == W1 and works[W1]["cited_by_count"] == 12


def test_mismatched_singleton_redirect_is_rejected(files):
    report = run(files, Session([{"results": []}, remote(W2, doi="https://doi.org/10.9999/wrong"), {"id": W1}]))
    assert not report["complete"] and report["refreshed"] == 0
    assert "identity mismatch" in report["failed"][0]["error"]


def test_original_doi_alias_can_confirm_a_merge_with_a_changed_canonical_doi(files):
    session = Session([{"results": []}, remote(W2, doi="https://doi.org/10.9999/alias"), {"id": W2}])
    report = run(files, session)
    assert report["complete"] and report["refreshed"] == 1
    assert session.calls[-1][0] == "https://api.openalex.org/works/https://doi.org/10.1234/test"
    assert json.loads(files[3].read_text())["works"][W1]["citation_stats_source_work_id"] == W2


@pytest.mark.parametrize("title,year,accepted", [
    ("ORIGINAL TITLE.", 2018, True), ("Different title", 2018, False), ("Original title", 2019, False),
])
def test_retired_doi_requires_id_redirect_and_matching_title_and_year(files, title, year, accepted):
    response = requests.Response()
    response.status_code = 404
    session = Session([{"results": []}, remote(W2, doi="https://doi.org/10.9999/alias",
                       display_name=title, publication_year=year), requests.HTTPError(response=response)])
    report = run(files, session)
    assert report["complete"] is accepted
    assert report["refreshed"] == int(accepted)
    if accepted:
        assert report["changes"][0]["identity_resolution"] == "merged_id_verified_title_and_year"


def test_stats_snapshot_cannot_override_authorship_and_missing_files_stop_build(files):
    csv, cache, patch, stats, _ = files
    stats.write_text(json.dumps({"schema_version": 1, "works": {W1: {
        **stats_fields(remote(), STAMP), "authorships": [],
    }}}))
    with pytest.raises(ValueError, match="citation statistics"):
        load_patches(patch)
    stats.unlink()
    with pytest.raises(ValueError, match="citation statistics"):
        load_patches(patch)


def test_repeated_refreshes_accept_decreases_and_retain_unselected_work_stats(files):
    csv, cache, patch, stats, _ = files
    other = stats_fields(remote(W2), STAMP)
    stats.write_text(json.dumps({"schema_version": 1, "works": {W2: other}}))
    assert run(files, Session([{"results": [remote()]}]))["complete"]
    report = run(files, Session([{"results": [remote(count=0)]}]))
    assert report["complete"] and report["changes"][0]["delta"] == -12
    assert json.loads(stats.read_text())["works"][W1]["cited_by_count"] == 0
    assert json.loads(stats.read_text())["works"][W2] == other


def test_report_counts_unique_papers_per_root_and_groups_lifetime_counts_by_publication_year():
    papers = {
        W1: {"publication_year": 2018, "cited_by_count": 12, "topic_ids": ["A", "A.1", "A.2", "B"],
             "citation_stats_refreshed_at": STAMP},
        W2: {"publication_year": 2026, "cited_by_count": 5, "topic_ids": ["A.1"]},
    }
    topics = {"A": {"name": "Root A"}, "A.1": {"name": "Child", "parent": "A"},
              "A.2": {"name": "Other child", "parent": "A"}, "B": {"name": "Root B"}}
    report = build_reports_data(papers, {}, topics, {})
    assert report["publications"]["total_citations"] == 17
    assert [r["citations"] for r in report["publications"]["years"]] == [12, 5]
    assert [r["cum_citations"] for r in report["publications"]["years"]] == [12, 17]
    roots = {t["topic_id"]: t for t in report["topics"]["topics"]}
    assert roots["A"]["cites_total"] == 17 and roots["B"]["cites_total"] == 12
    assert report["citation_stats"]["refreshed_papers"] == 1
    assert report["citation_stats"]["papers"] == 2
