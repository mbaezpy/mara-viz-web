# mara-viz-web

Static interface for exploring publications, topics, reports, and collaboration
networks. Serve this directory with `python -m http.server 8000` and open
`http://localhost:8000`.

Publication retrieval, the shared OpenAlex cache, metadata corrections, and data
generation now live in [processing/](processing/README.md). That guide documents
setup and the `check → fetch → manual topics → build` workflow, including the
current `publications_2026.csv` download reference. Manual topics are maintained
in `processing/inputs/publications_tagged.csv`, which is the default input for
`check` and `build`.

## Development checks

Install the Python dependencies described in the processing guide, then run:

```bash
python -m pip install pytest
python -m pytest -q
npm ci
npx playwright install chromium
npx playwright test --project=chromium
```

Node dependencies are only needed for browser tests. The served interface is
static. CSV inputs, reviewed metadata patches and citation snapshots are tracked;
the OpenAlex cache, source PDFs, historical archives and generated previews stay
local. Copy an existing cache into `processing/cache/openalex_cache.json` to reuse
downloads, or follow the processing guide to fetch missing records.
