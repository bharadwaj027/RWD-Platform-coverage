# RWD Coverage Ledger

A client-side tool that reads three axe Auditor CSV exports (Desktop/Web, RWD Tablet,
RWD Mobile) and builds a Success Criteria &times; Page &times; Platform matrix for VPAT authoring.
No backend, no build step — just static files.

## Files

| File          | What it is |
|---------------|------------|
| `index.html`  | Page structure/markup. Loads `papaparse.min.js` locally, then `style.css` and `script.js`. |
| `style.css`   | All styling. Design tokens (colors, fonts) are CSS variables at the top of the `:root` block. |
| `script.js`   | All app logic: CSV parsing, the Success-Criteria/Page/Platform matrix builder, search/filter/sort, CSV export. |
| `vpat-format.js` | The VPAT sentence assembly (`VPATFormat`), kept DOM-free so both the tool and the regression test run the exact same code. It builds a remark from a rule's source prose + the page/platform list — see below. |
| `test/vpat-regression.html` | Open in a browser to verify generated VPAT text matches `bulleted_vpat_text.json` exactly for the 4.1.2 rules (and that no `[S]` bracket is ever emitted). Shows PASS/FAIL — no build step or Node needed. |
| `config.json` | Editable settings — see below. Loaded via `fetch()` at startup; if that fails (e.g. opened via `file://` with no local server), the app falls back to the same values hard-coded in `script.js` so it still works. |
| `manifest.json` | Browser extension manifest for a Chrome/Edge/Brave popup extension. |
| `papaparse.min.js` | Local copy of PapaParse so the extension works without remote CDN access. |
| `bulleted_vpat_text.json` | **Primary** VPAT data source (from the Conformance Calculator) — an array of VPAT-Generator rows. Indexed at load by `Rule ID` for `VPAT Text One` / `VPAT Text Multiple` / `Short Text` / `Checkpoint` / `Standard` / `Issue Type` / `Impact`. Loaded via `fetch()`; if it can't load, the tool still runs and emits just the annotated page list. |
| `issue-descriptions.json` | **Supporting** data source (from the Conformance Calculator) — array keyed by `id` with `shortText` / `issueDescText` / `data[].checkpoint` / `standards`. Used only to fill in a rule's short text / checkpoint when `bulleted_vpat_text.json` lacks them; it never supplies VPAT prose. |

## VPAT text generation

Expand any Success Criteria row to see a **VPAT text** section: one paste-ready remark
per rule. Each remark is the VPAT Generator's prose — `VPAT Text One` when a single page
is affected, `VPAT Text Multiple` otherwise — followed by the affected pages, each with
the platform(s) it's present on in braces using the full VPAT wording, e.g.

```
An image does not have a text alternative … This occurs on the following page(s): Home {Desktop}; Checkout {Desktop, Responsive Web Design Tablet}.
```

The prose is looked up by the axe Auditor **`Rule Id`** column — **never** by Success
Criterion, because one checkpoint (e.g. `4.1.2.a`) contains many rules with different
wording (`expand-collapse-state`, `state-selected-missing-incorrect`, `control-missing-state`,
…). The lookup is Rule ID &rarr; entry in `bulleted_vpat_text.json`, with `Checkpoint` as an
additional validation key, falling back to `issue-descriptions.json` for supporting fields.

The descriptive sentence is used **exactly** as stored — the tool never rewrites, paraphrases,
re-pluralizes, or adds/removes words. It only does two things: pick `VPAT Text One` (a single
applicable page) or `VPAT Text Multiple` (more than one), and insert the page names at the
page-reference location. Because the source sentences end at the period and do **not** carry a
page clause, the tool appends the same clause the Conformance Calculator does —
`This occurs on the following page:` (one) / `pages:` (multiple) — then the page list, each page
annotated `{Platform}`. If a rule has no `VPAT Text One`/`Multiple`, it emits just the page list
(never invented wording). The `{Platform}` braces are the only RWD-specific addition; no `[S]`
or other bracket formatting is produced. Pages are listed in first-seen order, none repeated,
platforms comma-separated in one pair of braces. Platform labels live in `config.json` &rarr;
`vpatLabels`. **Export VPAT text (TXT)** dumps every remark at once. Run
`test/vpat-regression.html` in a browser to confirm exact-match fidelity.

These two Conformance Calculator files are the single source of truth — the tool keeps **no
duplicate VPAT/issue-description database** of its own.

Rules whose prose is **identical** (ignoring incidental whitespace) are merged into one
remark, pooling their pages (deduped case-insensitively, platforms unioned) — so two rules
that both read "An image does not have a text alternative…" become a single bullet listing
all affected pages once.

## Closed issues

The **Include Closed Issues** checkbox (in the toolbar, unchecked by default) controls whether
issues with `Issue Status` = `Closed` are considered. Unchecked → open issues only: closed
issues are dropped from every count, page name, platform mapping, and the VPAT text; a page
kept alive only by a closed issue disappears, while a page with both open and closed issues
survives on its open issue. Checked → open + closed are both counted and shown (a page with
both still appears once). Toggling re-runs the computation immediately.

## Success Criteria levels

The matrix groups Success Criteria into **Level A** and **Level AA** sections (plus an
"Other / Unspecified" section for anything outside the standard A/AA set), each with its own
expand/collapse toggle, both expanded by default. The level for each SC comes from the fixed
WCAG map (`WCAG_LEVEL` in `script.js`). Collapsing one level never affects the other, and all
counts, VPAT text, and closed-issue filtering work regardless of collapse state.

## How the data model works

1. Each row of an uploaded CSV is one accessibility issue on one page (the axe Auditor
   `Test Unit` column).
2. The platform(s) an issue applies to come from the `Desktop / RWD Tablet / RWD Mobile:`
   prefix on the `Summary` column, if present. If there's no prefix, the issue is
   attributed to whichever CSV it came from (`config.json` → `sourceDefaults`).
3. `recompute()` in `script.js` first groups everything by **page → checkpoint**
   (the axe Auditor `Checkpoint` column), then `buildScGroups()` re-groups the same
   data by **Success Criteria → page** for display. Both levels of granularity exist
   in `state.pages` and `state.scGroups` respectively, so nothing is lost — the "Export
   full detail" button reads straight from `state.pages` regardless of what's filtered
   on screen.

## config.json

```json
{
  "platforms": ["Desktop", "RWD Tablet", "RWD Mobile"],
  "sourceDefaults": { "web": "Desktop", "tablet": "RWD Tablet", "mobile": "RWD Mobile" },
  "columns": {
    "page": "Test Unit",
    "summary": "Summary",
    "checkpoint": "Checkpoint",
    "successCriteria": "Success Criteria",
    "checkpointGroup": "Checkpoint Group"
  },
  "siteWidePageName": "project wide"
}
```

- **`platforms`** — the canonical platform names. Renaming or reordering here updates
  every part of the matrix logic (the prefix-matching regex and the platform
  lookup table are both built from this array). Adding a 4th platform will need a
  matching upload dropzone added in `index.html`/`script.js` (`SOURCES` object) — the
  column/data-model side of `script.js` doesn't need to change.
- **`sourceDefaults`** — which platform to assume for a CSV row with no prefix on the
  Summary, keyed by upload slot (`web`/`tablet`/`mobile` — matches the three dropzones
  in `index.html`).
- **`columns`** — the axe Auditor CSV column names the app reads from. Change these if
  a differently-configured axe Auditor export uses different header names.
- **`siteWidePageName`** — the `Test Unit` value (case-insensitive) treated as a
  site-wide/project-wide item rather than an actual page, for the "Site-wide" tag.

## Running it

Any static file server works, e.g.:

```
npx serve .
```

or open `index.html` directly in a browser — `fetch('./config.json')` may be blocked
under a plain `file://` URL in some browsers (notably Chrome), in which case the app
silently uses the built-in fallback config in `script.js` instead.

## Known data quirks this tool already handles

- Page names that are spelled/cased differently between the three CSVs (e.g. "Bottom
  navigation" vs "Bottom Navigation") are merged case-insensitively for matching, but
  flagged with a &#9888; wherever they appear so you can confirm they're really the same page.
- A single Success Criteria (e.g. 1.4.11) can span several distinct axe Auditor
  checkpoints (e.g. "...States of User Interface Components" vs "...Graphical
  Objects") with different platform coverage from each other — these are aggregated
  at the SC level for the main view, with a checkpoint-count badge as a signal, and
  kept fully separated in the "Export full detail" CSV.
