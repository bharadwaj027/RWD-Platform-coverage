# RWD Coverage Ledger

A client-side tool that reads three axe Auditor CSV exports (Desktop/Web, RWD Tablet,
RWD Mobile) and builds a Success Criteria &times; Page &times; Platform matrix for VPAT authoring.
No backend, no build step — just static files.

## Files

| File          | What it is |
|---------------|------------|
| `index.html`  | Page structure/markup. Loads `papaparse.min.js` locally, then `style.css` and `script.js`. |
| `style.css`   | All styling. Design tokens (colors, fonts) are CSS variables at the top of the `:root` block. |
| `script.js`   | App presentation + wiring: rendering the matrix, search/filter/sort, CSV/VPAT export, and the shared-unit mapping UI. The page/rule model itself is built by `redistribute.js`. |
| `redistribute.js` | The page/rule model builder (`RWDModel.build`), kept DOM-free so the tool and its regression test run the exact same code. Reads every CSV row, builds the page universe (CSV + manual pages, each with platform presence), separates **components** and **marked project-wide pages** from real pages, and redistributes each mapped component / project-wide issue onto its target pages — see the sections below. |
| `vpat-format.js` | The VPAT sentence assembly (`VPATFormat`), kept DOM-free so both the tool and the regression test run the exact same code. It builds a remark from a rule's source prose + the page/platform list — see below. |
| `test/vpat-regression.html` | Open in a browser to verify generated VPAT text matches `bulleted_vpat_text.json` exactly for the 4.1.2 rules (and that no `[S]` bracket is ever emitted). Shows PASS/FAIL — no build step or Node needed. |
| `test/redistribution.html` | Open in a browser to verify component redistribution, presence-gating, manually added pages, and the project-wide 2b workflow (auto-detection, platform sections, per-issue mapping, override stickiness, no double-count). Shows PASS/FAIL — no build step or Node needed. |
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
An image does not have a text alternative … This occurs on the following page(s): Home (Desktop); Checkout (Desktop, Responsive Web Design Tablet).
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
annotated `(Platform)`. If a rule has no `VPAT Text One`/`Multiple`, it emits just the page list
(never invented wording). The `(Platform)` parentheses are the only RWD-specific addition; no `[S]`
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

## Map shared components

A **component** is a row whose `Unit Type` column is `Component` (a Header, Footer, Cookie
Wall, embedded video…) — a shared element, not a screen of its own. The **"Map shared
components"** section lists every component found, with its detected platforms and success
criteria, and lets you choose where each one applies:

- **All pages** — the component is treated as present on every in-scope page.
- **Selected pages** — tick the exact real pages it appears on.
- **Not mapped** (default) — it contributes nothing until you map it. A banner reports how
  many components are still unmapped. Use **Map all → All pages** to map every component to
  every page in one click.

(Project-wide / app-wide pages are handled separately, per-issue — see the next section.)

When a component is mapped, each of its findings is **redistributed** onto the target pages
and counted there as a direct page failure, exactly as if the issue had been logged on that
page. The platforms recorded on each target page are the **intersection of the finding's
platforms and the page's platform availability** — the finding's platforms are preserved,
never expanded to a platform the page does not exist on:

```
recorded platforms  =  issue/component platforms  ∩  page availability
```

**Platform availability vs. applicability.** These are deliberately separate — an issue's
platform is never inferred from the page, and a page never gets platforms it does not have:

- **Page availability** — *which platforms the page exists on.* A **CSV page** is available
  on the platform(s) whose export contains that page. A **manually added page** is available
  on exactly the platform(s) you chose for it.
- **Issue / component applicability** — *which platforms the finding occurs on* (from the
  Summary platform prefix, or the source CSV when unprefixed).

So a component/issue on **RWD Tablet + RWD Mobile** mapped to a page present in both RWD
exports records **both** RWD tags; if the selected page is absent from either export, that
platform tag is withheld. A **Desktop-only** finding records only Desktop, and the same
finding on a manually added *Desktop + RWD Mobile* page records **Desktop + RWD Mobile**.
If the RWD CSVs were never uploaded, RWD is out of scope and is never recorded.

A page is **never duplicated** — if it already fails that SC directly, the surviving
platforms merge into the existing row (the union is idempotent). Each redistributed page
shows a small **via _Unit_**
tag (and a `Redistributed From` column in the full-detail CSV) so you can trace where the
coverage came from. VPAT remarks include the redistributed pages the same way. Mapping
selections persist as you toggle Include-Closed or upload more files; units/pages that vanish
from the uploads are pruned from the mapping.

Run `test/redistribution.html` in a browser to confirm this behavior end-to-end.

## Add pages manually

Pages with **zero issues** never appear in a CSV, so they are missing from the page
universe, the mapping lists, and presence-gating. The **Add pages manually** section lets
you add them:

1. Type a page name and click **+ Add page**.
2. The tool asks **"Which platform is this page present on?"** — choose **Desktop**,
   **RWD Tablet**, **RWD Mobile**, or **All 3 platforms**. The page is added only after a
   platform is chosen.

Each added page joins the **page universe for the chosen platform(s)** — it becomes a
selectable target in every component / project-wide mapping list, and it carries that
platform as its **presence**, so redistribution gating treats it exactly like a CSV page: a
Desktop-only added page receives only Desktop from a component mapped onto it; an All-3 page
can receive all three. A zero-issue added page shows no failures of its own, but once a
shared unit is mapped onto it, it appears in the results (tagged **Added**).

**Duplicates** are checked per platform against the whole universe (CSV + manual). Adding a
page for a platform it is already present on is rejected with a message; adding the same
page name for a *different* platform is allowed (it extends that page's presence rather than
duplicating it). A validation message also appears for an empty/whitespace name. Added pages
are listed with a **Remove** control; removing one drops it from the universe and every
mapping list and recomputes. **Clear all files** clears manually added pages too.

> Note: this tool measures **per-Success-Criterion platform coverage** (1/2/3 platforms),
> not a page-percentage, so it has no page-count *denominator* or *pass-rate* metric — those
> belong to the Conformance Calculator. Manually added pages participate in everything this
> tool's page list actually drives: mapping targets, presence-gating, and appearing in
> results when a shared unit is redistributed onto them.

## Project-wide / app-wide pages (Section 2b)

Some audits log application-wide findings against a dedicated **project-wide / app-wide
page** instead of a real screen. That page is not a screen, so it is excluded from the page
universe and its **individual issues** are mapped onto the real pages where they reproduce.

**Mark project-wide pages.** A grid lists every page in the universe (CSV + manual). Pages
whose name matches *project-wide* / *app-wide* (or the configured `siteWidePageName`) are
**auto-ticked**; you can untick those or tick any other page, and **your choice sticks**
(it overrides the auto default and persists across recomputes/uploads). A marked page is
removed from the real page count and its rows become project-wide issues.

**Platform sections.** Project-wide issues are grouped by the platform(s) they apply to
(from the Summary prefix / source CSV) into clearly-labelled sections:

- **Project Wide — Desktop / RWD Tablet / RWD Mobile** — single-platform issues.
- **Project Wide — RWD Platforms** — issues on RWD Tablet + RWD Mobile (no Desktop).
- **Project Wide — All Platforms** — issues on all three.

Each section header shows `project-wide · N issues · M unmapped`. Every issue shows its
**Issue ID, severity, Success Criterion, platforms, description**, and a live `X / N pages`
count.

**Per-issue mapping.** For each issue you pick the real pages where it reproduces:
**All pages (N)** maps to the whole applicable universe (dynamic — includes manual pages
and updates as the universe changes); **Clear** unmaps it; ticking pages selects them; the
**filter/paste box + Select matches** selects pages by name (one per line or comma-separated).
The page list shown for an issue contains **only pages applicable to that issue's platform
context** — an RWD Tablet issue lists RWD-Tablet pages, an *All Platforms* issue lists all —
and it always includes **manually added pages**. Each mapped page receives the issue's SC as
a direct failure, on the issue's platforms **gated by the page's presence** (so an all-three
issue mapped onto a Desktop-only page lands only on Desktop). Unmapped issues count for
nothing. The same issue is never shown in two sections, so overall totals never double-count.

## How the data model works

1. Each row of an uploaded CSV is one accessibility issue on one `Test Unit`. A `Test Unit`
   whose `Unit Type` is `Component`, or that matches `siteWidePageName`, is a **shared unit**
   handled by the redistribution step above; every other `Test Unit` is a real page.
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
    "checkpointGroup": "Checkpoint Group",
    "unitType": "Unit Type"
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
- **`columns.unitType`** — the axe Auditor column whose value `Component` marks a row as a
  shared component (redistributed, not shown as its own page).
- **`siteWidePageName`** — the `Test Unit` value (case-insensitive) treated as the
  project-wide / app-wide container: excluded from the page list and redistributed onto the
  real pages you map it to (see "Components & project-wide redistribution").

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
