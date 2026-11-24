# Publication processing

This folder owns the workflow from a publication CSV to the datasets used by
Mara Viz. Topic assignment is manual. The two publication files have separate roles:

- `inputs/publications_2026.csv` is the reference list used for OpenAlex downloads.
- `inputs/publications_tagged.csv` is the manually maintained collection with
  `final_topics`, used to check annotations and build the web datasets.

The workflow never copies topic values from the reference list or assigns topics.

## Setup

Run these commands from `mara-viz-web` (Python 3.10 or newer):

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r processing/requirements.txt
```

The local `.venv` has already been created during the migration. The interface
itself remains a static website and does not need Python dependencies to run.

## Process the current list

`fetch` defaults to `inputs/publications_2026.csv`.
`check` and `build` default to `inputs/publications_tagged.csv`.

1. Inspect the manually tagged collection and cache:

   ```bash
   python -m processing.pipeline check
   ```

   The summary shows missing metadata, unknown topic IDs, duplicate identifiers,
   and publications awaiting topics. Both `check` and `build` print the CSV row,
   publication title, DOI / OpenAlex ID, and original `final_topics` value for
   each issue. Unknown IDs are listed individually, along with related defined
   topic IDs and names for reference. These are inspection aids; no tag is
   automatically corrected. Duplicate identifiers show the first matching row.

   Detailed reports are written before build validation, including when it fails:

   - `processing/runs/publications_tagged/status.json`: full validation details,
     topic definition path, and related topics.
   - `processing/runs/publications_tagged/validation_issues.csv`: spreadsheet of
     errors and warnings with row, DOI, title, original assignments, and details.

   Reports are refreshed on each run. `check` exits with status 1 when work
   remains. Topic validation checks that IDs exist in the chosen topic CSV; the
   relevance of an existing topic to a publication remains a manual decision.

2. Retrieve missing OpenAlex records from the download reference:

   ```bash
   python -m processing.pipeline fetch
   ```

   The download reference only needs a `DOI` column; topic columns, if present,
   are ignored. It is not validated as a tagged collection.
   Only cache misses are downloaded. Existing records and locally included works
   are reused. Progress is saved after every ten new records and on interruption;
   rerun the command to resume. HTTP failures are recorded in
   `processing/runs/publications_2026/retrieval.json` and cause a nonzero exit.
   Requests retry temporary errors and have timeouts. Authentication or budget
   failures stop retrieval after saving progress.

   A key can be supplied through `OPENALEX_API_KEY`; an optional contact email
   through `OPENALEX_EMAIL`. See [OpenAlex authentication](https://help.openalex.org/api/authentication/).
   Credentials are read from the environment and are not stored in the cache.

3. Add new publications and assign topics manually in
   `processing/inputs/publications_tagged.csv`:

   Keep the download reference unchanged. Add the publications you want included
   to the tagged file and maintain their topic assignments there.

   - Keep the `DOI`, `Title`, and `final_topics` columns.
   - Enter topic IDs from `processing/inputs/topics.csv` in `final_topics`.
   - Separate multiple IDs with commas, for example `B.1,C.2`.
   - A blank value means tagging is unfinished. Use `0` to explicitly exclude a
     publication, preserving the old generator's treatment of those rows.
   - Save as CSV. UTF-8 (with or without BOM) and Windows-1252 are supported, as
     are semicolon, comma, and tab delimiters. Quote fields containing delimiters
     or line breaks. Neither input file is rewritten by the scripts.

   The `DOI` field can also contain a bare OpenAlex work ID (`W187283018`) or its
   full URL. DOI URLs, capitalization, surrounding whitespace, and the trailing
   Excel `Â`/non-breaking-space artifact are normalized during lookup; the source
   CSV is not rewritten.

4. Check again, then build:

   ```bash
   python -m processing.pipeline check
   python -m processing.pipeline build
   ```

   A complete build requires all non-excluded rows to have valid topics and all
   tagged works to have metadata. Outputs go to
   `processing/runs/publications_tagged/data/`. To inspect the already tagged subset
   while manual tagging is in progress:

   ```bash
   python -m processing.pipeline build --allow-untagged
   ```

   This omits blank-topic rows. It still rejects unknown topic IDs and missing
   metadata for tagged publications. It never assigns topics for you.

5. After reviewing the results, regenerate the data served by the interface:

   ```bash
   python -m processing.pipeline build --output-dir data
   python -m http.server 8000
   ```

   Open `http://localhost:8000` and inspect Topics, Library, Reports, and the
   collaboration network. `--output-dir data` replaces the generated datasets in
   `mara-viz-web/data`; the default preview build leaves them alone. During tagging,
   you can explicitly combine `--allow-untagged --output-dir data` to display a
   partial dataset.

## A new list or a single publication

Put another download reference in `processing/inputs/` and pass it to `fetch`:

```bash
python -m processing.pipeline fetch processing/inputs/my_download_list.csv
# Add the new publications and manual final_topics to publications_tagged.csv.
python -m processing.pipeline check
python -m processing.pipeline build
python -m processing.pipeline build --output-dir data
```

To maintain an independent tagged collection, pass its CSV explicitly to `check`
and `build`, for example `python -m processing.pipeline build processing/inputs/my_tagged.csv`.

Each list gets `processing/runs/<CSV filename without extension>/`, and all lists
share the cache. A one-row CSV works for processing a single publication.
**The tagged input defines the entire output collection**: a one-row build
produces a one-publication dataset. To add an item to the displayed collection,
add it to `publications_tagged.csv` and rebuild. Downloading a work does not add
it to the displayed collection. Repeated DOI/OpenAlex identifiers are reported;
the generator combines their topic assignments and includes each matched work once.

For another cache, topic hierarchy, or correction file, use `--cache`,
`--topics-csv`, and `--patches`. All default paths are anchored to this folder;
explicit relative paths are resolved from your current working directory. You can
also run `python /absolute/path/to/processing/pipeline.py check` from elsewhere.

The web collaboration network uses authorships on the selected publications; it
does not require downloading their references. Add `--with-references` to `fetch`
only if you need cited works for separate analysis. It also finds references of
already cached input works and fetches only missing references.

## Refresh citation statistics

`fetch` intentionally skips cached publications. Neither `fetch` nor an ordinary
build refreshes their citation counts. A new build alone can therefore reproduce
old citation totals.

Refresh the manually tagged collection before generating current reports:

```bash
python -m processing.update_stats
python -m processing.pipeline build
```

The refresh always requests current statistics, even for cache hits. It writes
`patches/openalex_stats.json`, referenced by `stats_file` in
`patches/openalex_patches.json`. Builds load this snapshot automatically after
the manual metadata corrections. Only `cited_by_count`, `counts_by_year`, and
statistics provenance fields can be overridden; the cache, reviewed authorships,
affiliations, publication dates, titles, and manual topics are preserved.
Library counts, author totals, topic rankings and reports all use the refreshed
counts on the next build. The default build is a preview; use
`python -m processing.pipeline build --output-dir data` to regenerate served data.

The default refresh input is `inputs/publications_tagged.csv`. It also accepts
a reference CSV with only a DOI column, or several inputs together:

```bash
python -m processing.update_stats processing/inputs/publications_2026.csv
python -m processing.update_stats processing/inputs/publications_tagged.csv processing/inputs/another_list.csv
```

Identifiers are normalized and matched to the cache or locally included works.
Repeated identifiers and DOI/OpenAlex aliases are refreshed once. Rows explicitly
tagged `0` are skipped; blank-topic rows can be refreshed before manual tagging.
Missing metadata is reported with the input file, row, identifier and title;
run `fetch` for that input first. Refreshing another list does not delete snapshot
entries for previous lists or add publications to the displayed collection.

Requests select statistics and identity-verification fields in batches of up to
100. Singleton lookups resolve missing or merged IDs, verifying the original DOI
when its canonical DOI also changed. If the old DOI is unavailable, the original
ID must redirect and the normalized title and publication year must both match.
Counts remain attached to our existing work ID; the resolved source ID and
verification method are recorded. `OPENALEX_API_KEY` and `OPENALEX_EMAIL` use the same environment
configuration as `fetch`. No credentials are written to reports.

Successful batches are saved atomically, including on interruption. Failed
updates preserve previous counts and their previous refresh dates; unavailable
counts are never replaced with zero. A failed or incomplete run exits nonzero.
Re-running refreshes the selected collection again. Inspect
`runs/update_stats/report.json` for per-publication cached/previous/current counts,
deltas, input rows, failures, and unattempted works. Each snapshot entry records
its fetch time and OpenAlex source ID/update date. Malformed configured snapshots
stop the build. `--cache`, `--patches`, `--output`, `--report`, `--batch-size` and
`--delay` are available; if using a custom `--output`, point the build patch
configuration's `stats_file` at that file.

### What citation reports measure

Citation charts use **lifetime incoming citation counts grouped by publication
year**, not citations received during each calendar year. For example, a paper
published in 2018 with 12 lifetime citations contributes 12 to the 2018 bar,
including citations received later. The cumulative curve sums these publication
cohorts. The interface labels this explicitly and displays citation refresh
coverage and the oldest refresh date when available.

Each publication counts once in the corpus total and once in each distinct
top-level topic. Several child tags under the same root do not multiply it;
different roots receive the full count, so topic totals can overlap. All current
input publications have a publication year; publications without one cannot be
placed into the report's year series. `counts_by_year` is saved for inspection
but is not used by these charts. OpenAlex documents it as a limited historical
window, so it must not be summed as a replacement for lifetime `cited_by_count`.
See [OpenAlex work attributes](https://help.openalex.org/data/works/attributes/).

Reports cover every non-excluded tagged input publication. The library additionally
requires a recognized Mara authorship, so its displayed collection can be smaller
if a curated paper's affiliation metadata is incomplete. The current collection
has 445 papers in reports and 443 in the library; the build lists the two papers
without a recognized Mara author for review.

## Correcting OpenAlex metadata

Edit `processing/patches/openalex_patches.json`, then run `check` and `build` again.
`openalex_patcher.py` documents the correction schema, including work overrides,
authorship/affiliation corrections, author ID replacements, and local-author
overrides. `topics_to_d3.py` contains the existing `LOCAL_AFFILIATIONS` definitions.

Large authorship corrections can live in a JSON file beside the patch index:

```json
"https://openalex.org/W7140298212": {
  "mode": "merge",
  "work_overrides_file": "W7140298212.authorships.json"
}
```

The referenced file contains a work-overrides object, such as `{"authorships": [...]}`.
Paths are relative to `patches/openalex_patches.json`; inline `work_overrides`, when
present, take precedence. A missing or invalid referenced file stops validation.

The PDF-reviewed corrections for `W7140298212` (input row 417) and `W7128793906`
(row 443) retain group members, consolidate verified repeated identities, and
record `authorship_roles`, `is_byline_author`, and `byline_position` for inspection.
Their explicit `main_author` and `author_position` values preserve the published
first/last authors, including equal-contribution authors. A group member appended
after the byline is not treated as the last author. Group credits are stored in
`collaboration_groups`; the collective name is not counted as a person. Each
correction file records the source PDF checksum and review details.

Additional reviewed corrections use the same format:

- `W2784071103.authorships.json` preserves the five authors of the hyponatremia
  paper. Professor Christian G. Bien and Corinna Bien have distinct author IDs;
  the publisher assigns Mara and Labor Krone to the former, and Labor Krone only
  to the latter.
- `W2894432237.authorships.json` contains 14 Everolimus byline authors and all 104
  investigator credits as 113 distinct people. Affiliation assignments follow
  `inputs/paper_207.pdf` and its linked investigator appendix. Published institution
  names are retained when no verified identifier is available. The conflicting
  Hiroko Ikeda profile is corrected only for this publication, without globally
  merging the unrelated Hoshi University researcher.
- `W4392047307.authorships.json` corrects the anti-Caspr2 pain paper using its
  PMC article and the cache: 32 byline authors and all 181 GENERATE member
  credits are retained as 208 distinct people. Five repeated byline/member
  identities, including the misspelling “Felix von Poderwils”, are consolidated.
  The joint first authors and last/corresponding author are explicit. Byline
  affiliations follow the published cross-references; group-only affiliations
  retained from the cache are marked as unverified. Christian G. Bien and Anna
  Rada have the published Mara affiliation; Corinna Bien remains separate.

For a work missing from OpenAlex retrieval, an OpenAlex-shaped JSON record can be
stored in `processing/patches/` and listed in the patch file's `include` array.
Paths in `include` are relative to `patches/openalex_patches.json`; for example,
use `"W187283018.json"` for a record in the same folder. The existing
`patches/W187283018.json` record and all existing corrections have been moved
together. Corrections are applied in memory when generating datasets; cached raw
responses are retained.

## Files and execution order

```text
processing/
  pipeline.py                 check / fetch / build entry point
  paper_retrieve.py           resumable OpenAlex retrieval
  update_stats.py             refresh citation statistics into a separate snapshot
  csv_io.py                   CSV encoding and delimiter support
  topics_to_d3.py             corrected metadata → topic/library/report JSON
  collab_network.py           topics_lookup.json → collaboration network
  openalex_patcher.py         correction implementation and schema documentation
  patches/openalex_patches.json  curated corrections
  patches/                    manually supplied work records
  inputs/                     download reference, manual tagged collection, topic hierarchy
  cache/openalex_cache.json   shared raw responses; moved from utils, not reset
  cache/migration.json        checksum and count before new retrieval
  patches/openalex_stats.json current statistics overrides with per-work provenance
  runs/<list>/                status, retrieval report, generated preview datasets
  archive/metadata/           original scripts, intermediate CSVs and network exports
  archive/topic_tagging/      former tagging experiments, spreadsheets and notes
```

`build` runs `topics_to_d3.py` first, then the newer `collab_network.py`. All web
datasets are generated together in the chosen directory:

- `topics_hierarchy.json`, `topics_lookup.json`
- `library_publications.json`, `library_authors.json`, `reports.json`
- `oa_coauth.json`, `oa_coauth.graphml`, `oa_coauth.gexf`
- `oa_coauth_vos_map.tsv`, `oa_coauth_vos_network.tsv`

The old `papers_metadata.csv`, `authors.csv`, `citations_edges.csv`, and
`refs_metadata.csv` are historical intermediates. The current pipeline consumes
the shared JSON cache directly. Do not run the archived network builder or topic
classifier for this workflow. Archived scripts retain their original paths and
assumptions and are kept for reference.

The cache, generated runs, virtual environment, source PDFs, and historical
archives are ignored by Git. The archive layout above describes retained local
history; a fresh checkout does not contain those files. Back up
`processing/cache/`, `processing/archive/`, and any source PDFs separately when
moving to another machine. A fresh checkout alone will not contain downloads.


## Verification

```bash
python -m pip install pytest
python -m pytest -q
```

Tests cover metadata corrections, CSV encoding, DOI/OpenAlex ID handling, cache
reuse and recovery, optional reference retrieval, manual-tag validation, citation
refresh failure recovery and merged IDs, report aggregation, and a complete build
into an isolated output directory. Tests do not call OpenAlex.
