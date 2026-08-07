(function(){
  // ---------- Config (loaded from config.json, with a built-in fallback so the
  // tool still works if it's opened in a context that can't fetch local files) ----------
  const DEFAULT_CONFIG = {
    platforms: ['Desktop', 'RWD Tablet', 'RWD Mobile'],
    // Full platform names used in the generated VPAT text (the tool's short internal
    // labels aren't the wording VPATs use). Editable in config.json.
    vpatLabels: {
      'Desktop': 'Desktop',
      'RWD Tablet': 'Responsive Web Design Tablet',
      'RWD Mobile': 'Responsive Web Design Mobile'
    },
    sourceDefaults: { web: 'Desktop', tablet: 'RWD Tablet', mobile: 'RWD Mobile' },
    columns: {
      page: 'Test Unit',
      summary: 'Summary',
      checkpoint: 'Checkpoint',
      ruleId: 'Rule Id',
      issueStatus: 'Issue Status',
      successCriteria: 'Success Criteria',
      checkpointGroup: 'Checkpoint Group'
    },
    siteWidePageName: 'project wide'
  };

  let CONFIG = DEFAULT_CONFIG;
  let PLATFORMS = [];
  let PREFIX_RE = null;
  let PLATFORM_LOOKUP = {};

  // Conformance Calculator data sources (the single source of truth for issue/VPAT
  // info — no duplicate database is kept in this tool):
  //   VPAT_LOOKUP  — from bulleted_vpat_text.json, keyed by Rule ID. Primary source of
  //                  VPAT prose: { one, multiple, short, cp, standard, issueType, impact }.
  //   ISSUE_DESC   — from issue-descriptions.json, keyed by id. Supporting source of
  //                  issue descriptions / checkpoint mapping: { short, desc, cp, standards }.
  // Both load at startup; if either can't be fetched the tool still works and falls back
  // to emitting the page list on its own (it never invents VPAT wording).
  let VPAT_LOOKUP = {};
  let ISSUE_DESC = {};

  // bulleted_vpat_text.json is an array of VPAT-Generator rows. Index it by Rule ID,
  // preferring the row that actually carries prose when a rule appears more than once.
  function buildVpatLookup(rows){
    const map = {};
    (rows || []).forEach(r => {
      const rid = (r['Rule ID'] || '').toString().trim().toLowerCase();
      if (!rid) return;
      const entry = {
        one: r['VPAT Text One'] || null,
        multiple: r['VPAT Text Multiple'] || null,
        short: r['Short Text'] || r['Removed Short Text'] || null,
        cp: r['Checkpoint'] || null,
        standard: r['Standard'] || null,
        issueType: r['Issue Type'] || null,
        impact: r['Impact'] || null
      };
      const existing = map[rid];
      if (!existing || (!(existing.one || existing.multiple) && (entry.one || entry.multiple))) {
        map[rid] = entry;
      }
    });
    return map;
  }

  // issue-descriptions.json is an array keyed by `id`. Keep the supporting fields.
  function buildIssueDesc(rows){
    const map = {};
    (rows || []).forEach(it => {
      const id = (it.id || '').toString().trim().toLowerCase();
      if (!id) return;
      const d0 = (it.data && it.data[0]) || {};
      map[id] = {
        short: it.shortText || null,
        desc: it.issueDescText || null,
        cp: d0.checkpoint || null,
        standards: d0.standards || []
      };
    });
    return map;
  }

  // Resolve a rule's entry: bulleted_vpat_text.json first (Rule ID), enriched from
  // issue-descriptions.json for any missing supporting field. Returns null if neither
  // source knows the rule. VPAT prose (one/multiple) only ever comes from the bulleted
  // source — issue-descriptions never supplies prose (so wording is never invented).
  function vpatEntry(ruleId){
    const rid = (ruleId || '').toString().trim().toLowerCase();
    if (!rid) return null;
    const base = VPAT_LOOKUP[rid];
    const desc = ISSUE_DESC[rid];
    if (!base && !desc) return null;
    const e = base ? Object.assign({}, base) : { one: null, multiple: null };
    if (desc) {
      if (!e.short) e.short = desc.short;
      if (!e.cp) e.cp = desc.cp;
      if (!e.description) e.description = desc.desc;
    }
    return e;
  }

  function escapeRegex(s){
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Turns ["Desktop","RWD Tablet"] into a case-insensitive alternation that also
  // tolerates extra/odd whitespace between words (so "RWD  Tablet" still matches).
  function buildPrefixRegex(platforms){
    const alt = platforms
      .map(p => p.trim().split(/\s+/).map(escapeRegex).join('\\s*'))
      .join('|');
    return new RegExp('^\\s*((?:' + alt + ')(?:\\s*,\\s*(?:' + alt + '))*)\\s*:\\s*', 'i');
  }

  // Maps a cleaned "desktop" / "rwd tablet" back to the canonical spelling from config.
  function buildPlatformLookup(platforms){
    const map = {};
    platforms.forEach(p => { map[p.trim().replace(/\s+/g, ' ').toLowerCase()] = p; });
    return map;
  }

  function applyConfig(cfg){
    CONFIG = cfg;
    PLATFORMS = cfg.platforms.slice();
    PREFIX_RE = buildPrefixRegex(PLATFORMS);
    PLATFORM_LOOKUP = buildPlatformLookup(PLATFORMS);
  }

  applyConfig(DEFAULT_CONFIG); // safe to use immediately; upgraded below if config.json loads

  fetch('./config.json')
    .then(res => (res.ok ? res.json() : null))
    .then(cfg => { if (cfg && cfg.platforms) applyConfig(cfg); })
    .catch(() => { /* keep DEFAULT_CONFIG */ });

  fetch('./bulleted_vpat_text.json')
    .then(res => (res.ok ? res.json() : null))
    .then(rows => { if (rows) { VPAT_LOOKUP = buildVpatLookup(rows); if (state.pages.length) render(); } })
    .catch(() => { /* keep empty VPAT_LOOKUP — page list still generated */ });

  fetch('./issue-descriptions.json')
    .then(res => (res.ok ? res.json() : null))
    .then(rows => { if (rows) { ISSUE_DESC = buildIssueDesc(rows); if (state.pages.length) render(); } })
    .catch(() => { /* supporting source only */ });

  // DOM wiring only — which upload zone maps to which element ids. The platform each
  // one defaults to when an issue has no prefix comes from CONFIG.sourceDefaults instead,
  // so that mapping can be edited in config.json without touching this file.
  const SOURCES = {
    web:    { inputId: 'file-web',    statusId: 'status-web',    dzId: 'dz-web' },
    tablet: { inputId: 'file-tablet', statusId: 'status-tablet', dzId: 'dz-tablet' },
    mobile: { inputId: 'file-mobile', statusId: 'status-mobile', dzId: 'dz-mobile' }
  };

  function defaultPlatformFor(srcKey){
    return CONFIG.sourceDefaults[srcKey];
  }

  function emptyCounts(){
    const o = {};
    PLATFORMS.forEach(p => { o[p] = 0; });
    return o;
  }

  const state = {
    files: { web: null, tablet: null, mobile: null }, // { name, rows }
    pages: [],
    scGroups: [],
    sort: { key: 'sc', dir: 'asc' },
    search: '',
    tier: 'all',
    includeClosed: false, // when false, "Closed" issues are ignored everywhere
    levelCollapsed: { A: false, AA: false, Other: false }, // WCAG level sections; false = expanded
    expanded: new Set() // sc-group keys with page drill-down open
  };

  // WCAG conformance level per Success Criterion (2.0 / 2.1 / 2.2, Levels A & AA).
  // Levels are fixed by the spec, so this is a static lookup; anything not listed
  // (AAA or non-standard) falls into the "Other" section rather than being dropped.
  const WCAG_LEVEL = {
    '1.1.1':'A','1.2.1':'A','1.2.2':'A','1.2.3':'A','1.3.1':'A','1.3.2':'A','1.3.3':'A',
    '1.4.1':'A','1.4.2':'A','2.1.1':'A','2.1.2':'A','2.1.4':'A','2.2.1':'A','2.2.2':'A',
    '2.3.1':'A','2.4.1':'A','2.4.2':'A','2.4.3':'A','2.4.4':'A','2.5.1':'A','2.5.2':'A',
    '2.5.3':'A','2.5.4':'A','3.1.1':'A','3.2.1':'A','3.2.2':'A','3.2.6':'A','3.3.1':'A',
    '3.3.2':'A','3.3.7':'A','4.1.1':'A','4.1.2':'A',
    '1.2.4':'AA','1.2.5':'AA','1.3.4':'AA','1.3.5':'AA','1.4.3':'AA','1.4.4':'AA','1.4.5':'AA',
    '1.4.10':'AA','1.4.11':'AA','1.4.12':'AA','1.4.13':'AA','2.4.5':'AA','2.4.6':'AA','2.4.7':'AA',
    '2.4.11':'AA','2.5.7':'AA','2.5.8':'AA','3.1.2':'AA','3.2.3':'AA','3.2.4':'AA','3.3.3':'AA',
    '3.3.4':'AA','3.3.8':'AA','4.1.3':'AA'
  };
  const LEVEL_ORDER = ['A', 'AA', 'Other'];
  const LEVEL_LABEL = { A: 'Level A', AA: 'Level AA', Other: 'Other / Unspecified' };

  function levelForSc(sc){
    return WCAG_LEVEL[String(sc || '').trim()] || 'Other';
  }

  function compareSC(a, b){
    const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  function normalizeToken(t){
    const clean = t.trim().replace(/\s+/g, ' ').toLowerCase();
    return PLATFORM_LOOKUP[clean] || t.trim();
  }

  function parseTokens(summary, defaultPlatform){
    const m = String(summary || '').match(PREFIX_RE);
    if (m) return m[1].split(',').map(normalizeToken);
    return [defaultPlatform];
  }

  function announce(msg){
    document.getElementById('ariaLive').textContent = msg;
  }

  function handleFile(srcKey, file){
    const cfg = SOURCES[srcKey];
    const statusEl = document.getElementById(cfg.statusId);
    const dzEl = document.getElementById(cfg.dzId);
    dzEl.classList.remove('has-error', 'is-loaded');
    statusEl.className = 'dz-status';
    statusEl.textContent = 'Reading ' + file.name + '…';

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: function(results){
        const rows = results.data || [];
        if (!rows.length || !(CONFIG.columns.page in rows[0]) || !(CONFIG.columns.summary in rows[0])) {
          dzEl.classList.add('has-error');
          statusEl.className = 'dz-status err';
          statusEl.textContent = 'This file is missing "' + CONFIG.columns.page + '" or "' + CONFIG.columns.summary + '" columns — is it an axe Auditor export?';
          return;
        }
        state.files[srcKey] = { name: file.name, rows: rows };
        dzEl.classList.add('is-loaded');
        statusEl.className = 'dz-status ok';
        statusEl.innerHTML = '&#10003; Loaded &middot; ' + rows.length + ' issue rows<span class="fname">' + escapeHtml(file.name) + '</span>';
        announce('Loaded ' + srcKey + ' CSV, ' + rows.length + ' rows.');
        recompute();
      },
      error: function(err){
        dzEl.classList.add('has-error');
        statusEl.className = 'dz-status err';
        statusEl.textContent = 'Could not read this file: ' + err.message;
      }
    });
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function recompute(){
    const pagesMap = new Map();
    const rulesMap = new Map(); // ruleKey -> { ruleId, sc, checkpoint, pages: Map(pageKey -> {display, platforms}) }
    const COLS = CONFIG.columns;

    Object.keys(SOURCES).forEach(srcKey => {
      const data = state.files[srcKey];
      if (!data) return;
      const defaultPlatform = defaultPlatformFor(srcKey);

      data.rows.forEach(row => {
        // Unless "Include Closed Issues" is on, drop Closed issues entirely — they then
        // affect no count, page name, platform, or VPAT text. A page kept alive only by
        // a Closed issue disappears; a page with both open and closed issues survives on
        // its open issue alone. This single filter drives all the closed-issue rules.
        if (!state.includeClosed) {
          const status = (row[COLS.issueStatus] || '').toString().trim().toLowerCase();
          if (status === 'closed') return;
        }

        const pageRaw = (row[COLS.page] || '').toString().trim();
        if (!pageRaw) return;
        const key = pageRaw.toLowerCase();

        if (!pagesMap.has(key)) {
          pagesMap.set(key, {
            display: pageRaw,
            variants: new Set(),
            platforms: new Set(),
            counts: emptyCounts(),
            totalRows: 0,
            checkpoints: new Map() // checkpointKey -> { label, sc, group, platforms, counts, totalRows }
          });
        }
        const p = pagesMap.get(key);
        p.variants.add(pageRaw);
        p.totalRows += 1;

        const tokens = parseTokens(row[COLS.summary], defaultPlatform);
        tokens.forEach(t => {
          if (PLATFORMS.includes(t)) {
            p.platforms.add(t);
            p.counts[t] += 1;
          }
        });

        const cpLabel = (row[COLS.checkpoint] || row[COLS.successCriteria] || 'Unspecified checkpoint').toString().trim();
        const cpKey = cpLabel.toLowerCase();
        if (!p.checkpoints.has(cpKey)) {
          p.checkpoints.set(cpKey, {
            label: cpLabel,
            sc: (row[COLS.successCriteria] || '').toString().trim(),
            group: (row[COLS.checkpointGroup] || '').toString().trim(),
            platforms: new Set(),
            counts: emptyCounts(),
            totalRows: 0
          });
        }
        const cp = p.checkpoints.get(cpKey);
        cp.totalRows += 1;
        tokens.forEach(t => {
          if (PLATFORMS.includes(t)) {
            cp.platforms.add(t);
            cp.counts[t] += 1;
          }
        });

        // Rule-level accumulation for VPAT prose. The VPAT Generator keys its remark
        // text by Rule Id, and one checkpoint code (e.g. 1.1.1.a) spans several rules
        // with different wording — so the VPAT paragraph unit is the rule, not the
        // axe "Checkpoint" string. Fall back to the checkpoint key when Rule Id absent.
        const ruleId = (row[COLS.ruleId] || '').toString().trim();
        const ruleKey = (ruleId ? 'rid:' + ruleId.toLowerCase() : 'cp:' + cpKey);
        if (!rulesMap.has(ruleKey)) {
          rulesMap.set(ruleKey, {
            ruleId: ruleId,
            sc: (row[COLS.successCriteria] || '').toString().trim(),
            checkpoint: cpLabel,
            pages: new Map()
          });
        }
        const rg = rulesMap.get(ruleKey);
        if (!rg.pages.has(key)) rg.pages.set(key, { display: pageRaw, platforms: new Set() });
        const rgp = rg.pages.get(key);
        tokens.forEach(t => { if (PLATFORMS.includes(t)) rgp.platforms.add(t); });
      });
    });

    state.pages = Array.from(pagesMap.entries()).map(([key, p]) => ({
      key: key,
      display: p.display,
      variants: Array.from(p.variants),
      hasVariantMismatch: p.variants.size > 1,
      isSiteWide: p.display.toLowerCase() === CONFIG.siteWidePageName,
      platforms: p.platforms,
      counts: p.counts,
      coverage: p.platforms.size,
      totalRows: p.totalRows,
      checkpoints: Array.from(p.checkpoints.values())
        .map(cp => ({ ...cp, coverage: cp.platforms.size }))
        .sort((a, b) => compareSC(a.sc, b.sc) || a.label.localeCompare(b.label))
    }));

    state.scGroups = buildScGroups(state.pages);

    // Rule-level VPAT groups (one paste-ready remark per rule), sorted by SC then
    // checkpoint, and indexed by the same key scGroups use (sc || checkpoint string)
    // so each SC panel can show the VPAT text for every rule it covers.
    state.ruleGroups = Array.from(rulesMap.values())
      .map(rg => ({
        ruleId: rg.ruleId,
        sc: rg.sc,
        checkpoint: rg.checkpoint,
        pages: Array.from(rg.pages, ([key, v]) => ({ key: key, display: v.display, platforms: v.platforms }))
      }))
      .sort((a, b) => compareSC(a.sc, b.sc) || a.checkpoint.localeCompare(b.checkpoint));

    state.rulesBySc = new Map();
    state.ruleGroups.forEach(rg => {
      const k = rg.sc || rg.checkpoint;
      if (!state.rulesBySc.has(k)) state.rulesBySc.set(k, []);
      state.rulesBySc.get(k).push(rg);
    });

    render();
  }

  function buildScGroups(pages){
    const scMap = new Map(); // scKey -> group

    pages.forEach(page => {
      page.checkpoints.forEach(cp => {
        const scKey = cp.sc || cp.label;

        if (!scMap.has(scKey)) {
          scMap.set(scKey, {
            sc: cp.sc,
            group: cp.group,
            checkpointLabels: new Set(),
            platforms: new Set(),
            counts: emptyCounts(),
            totalRows: 0,
            pages: new Map()
          });
        }
        const g = scMap.get(scKey);
        g.checkpointLabels.add(cp.label);
        if (!g.group && cp.group) g.group = cp.group;
        g.totalRows += cp.totalRows;
        PLATFORMS.forEach(pl => {
          if (cp.platforms.has(pl)) { g.platforms.add(pl); g.counts[pl] += cp.counts[pl]; }
        });

        if (!g.pages.has(page.key)) {
          g.pages.set(page.key, {
            key: page.key,
            display: page.display,
            variants: page.variants,
            hasVariantMismatch: page.hasVariantMismatch,
            isSiteWide: page.isSiteWide,
            platforms: new Set(),
            counts: emptyCounts(),
            totalRows: 0,
            checkpointLabels: new Set()
          });
        }
        const gp = g.pages.get(page.key);
        gp.checkpointLabels.add(cp.label);
        gp.totalRows += cp.totalRows;
        PLATFORMS.forEach(pl => {
          if (cp.platforms.has(pl)) { gp.platforms.add(pl); gp.counts[pl] += cp.counts[pl]; }
        });
      });
    });

    return Array.from(scMap.values()).map(g => ({
      key: g.sc || Array.from(g.checkpointLabels)[0] || 'unspecified',
      sc: g.sc,
      group: g.group,
      checkpointLabels: Array.from(g.checkpointLabels).sort(),
      platforms: g.platforms,
      counts: g.counts,
      coverage: g.platforms.size,
      totalRows: g.totalRows,
      pages: Array.from(g.pages.values())
        .map(p => ({ ...p, coverage: p.platforms.size, checkpointLabels: Array.from(p.checkpointLabels).sort() }))
        .sort((a, b) => a.display.localeCompare(b.display))
    })).sort((a, b) => compareSC(a.sc, b.sc));
  }

  // ---------- VPAT text generation ----------

  // Canonical platform order (Desktop, Tablet, Mobile) mapped to the full VPAT wording.
  function vpatLabel(platform){
    return (CONFIG.vpatLabels && CONFIG.vpatLabels[platform]) || platform;
  }

  // "Page Name {Desktop, Responsive Web Design Tablet}" for one affected page.
  function vpatPageLine(pg){
    const plats = PLATFORMS.filter(p => pg.platforms.has(p)).map(vpatLabel);
    return pg.display + ' {' + plats.join(', ') + '}';
  }

  // Merge rules that resolve to the SAME VPAT prose into one remark, pooling their
  // pages: deduped by page (case-insensitive), platforms unioned, so a page never
  // appears twice. Rules with no prose stay separate (keyed by rule). Order follows
  // first appearance. Returns [{ one, multiple, hasProse, pages:[{display,platforms}] }].
  function mergeRulesByText(rules){
    const map = new Map();
    const order = [];
    const normText = s => (s || '').replace(/\s+/g, ' ').trim();
    rules.forEach(rg => {
      const entry = vpatEntry(rg.ruleId);
      // Only entries with actual prose merge by text; prose-less rules (best-practice
      // rows exist in the source with null VPAT text) stay separate, keyed by rule, so
      // they don't all collapse into a single empty-text bullet. The merge key is
      // whitespace-normalized so rules whose source wording differs only by stray
      // spaces (e.g. a trailing space) still merge; the displayed wording is untouched.
      const hasProse = !!(entry && (entry.one || entry.multiple));
      const textKey = hasProse
        ? ('t\x01' + normText(entry.one) + '\x01' + normText(entry.multiple))
        : ('r\x01' + (rg.ruleId || rg.checkpoint));
      if (!map.has(textKey)) {
        map.set(textKey, { one: entry && entry.one, multiple: entry && entry.multiple, hasProse: hasProse, pages: new Map() });
        order.push(textKey);
      }
      const m = map.get(textKey);
      rg.pages.forEach(pg => {
        if (!m.pages.has(pg.key)) m.pages.set(pg.key, { display: pg.display, platforms: new Set(pg.platforms) });
        else { const ex = m.pages.get(pg.key); pg.platforms.forEach(p => ex.platforms.add(p)); }
      });
    });
    return order.map(k => {
      const m = map.get(k);
      return { one: m.one, multiple: m.multiple, hasProse: m.hasProse, pages: Array.from(m.pages.values()) };
    });
  }

  // The full paste-ready VPAT remark for a merged group: the Generator's prose (One
  // when a single page is affected, Multiple otherwise) followed by the annotated page
  // list. The prose already ends with "This occurs on the following page(s):" — the
  // pages are appended verbatim. With no prose, just the page list is used.
  function vpatRemark(m){
    const pageList = m.pages.map(vpatPageLine).join('; ') + '.';
    if (!m.hasProse) return pageList;
    let prose = (m.pages.length === 1 ? m.one : m.multiple) || m.one || m.multiple;
    if (!prose) return pageList;
    prose = prose.replace(/\s+$/, ''); // drop any trailing whitespace before the page list
    return prose + ' ' + pageList;
  }

  function render(){
    const loadedCount = Object.values(state.files).filter(Boolean).length;
    const hasAny = loadedCount > 0;

    document.getElementById('emptyState').hidden = hasAny;
    document.getElementById('stats').hidden = !hasAny;
    document.getElementById('toolbar').hidden = !hasAny;
    document.getElementById('tableWrap').hidden = !hasAny;

    const banner = document.getElementById('completenessBanner');
    if (hasAny && loadedCount < 3) {
      const missing = Object.keys(SOURCES).filter(k => !state.files[k]);
      const labels = { web: 'Desktop / Web', tablet: 'RWD Tablet', mobile: 'RWD Mobile' };
      banner.hidden = false;
      document.getElementById('completenessText').textContent =
        'Only ' + loadedCount + ' of 3 CSVs uploaded. Missing: ' + missing.map(m => labels[m]).join(', ') +
        '. Platforms shown as absent below may just be missing data, not confirmed compliance.';
    } else {
      banner.hidden = true;
    }

    if (!hasAny) return;

    const groups = state.scGroups;
    const full = groups.filter(g => g.coverage === 3).length;
    const partial = groups.filter(g => g.coverage === 2).length;
    const single = groups.filter(g => g.coverage === 1).length;

    document.getElementById('statTotal').textContent = groups.length;
    document.getElementById('statFull').textContent = full;
    document.getElementById('statPartial').textContent = partial;
    document.getElementById('statSingle').textContent = single;

    renderTable();
  }

  function scHeaderMatchesQuery(g, q){
    return (g.sc || '').toLowerCase().includes(q) ||
      (g.group || '').toLowerCase().includes(q) ||
      g.checkpointLabels.some(l => l.toLowerCase().includes(q));
  }

  function scGroupMatchesQuery(g, q){
    if (scHeaderMatchesQuery(g, q)) return true;
    return g.pages.some(p => p.display.toLowerCase().includes(q));
  }

  function visiblePagesFor(g, q){
    if (!q) return g.pages;
    if (scHeaderMatchesQuery(g, q)) return g.pages;
    return g.pages.filter(p => p.display.toLowerCase().includes(q));
  }

  function getFilteredSorted(){
    let rows = state.scGroups.slice();

    if (state.search) {
      const q = state.search.toLowerCase();
      rows = rows.filter(r => scGroupMatchesQuery(r, q));
    }
    if (state.tier !== 'all') {
      const tierNum = Number(state.tier);
      rows = rows.filter(r => r.coverage === tierNum);
    }

    const { key, dir } = state.sort;
    rows.sort((a, b) => {
      let cmp;
      if (key === 'sc') cmp = compareSC(a.sc, b.sc);
      else cmp = a[key] - b[key];
      if (cmp === 0) cmp = compareSC(a.sc, b.sc);
      return dir === 'asc' ? cmp : -cmp;
    });

    return rows;
  }

  function platformCellHtml(page, platform){
    const present = page.platforms.has(platform);
    const icons = {
      'Desktop': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="1.4"/><line x1="8" y1="20.5" x2="16" y2="20.5"/><line x1="12" y1="17" x2="12" y2="20.5"/></svg>',
      'RWD Tablet': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2.5" width="16" height="19" rx="2"/><line x1="12" y1="18.6" x2="12" y2="18.7"/></svg>',
      'RWD Mobile': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2.2"/><line x1="12" y1="18.3" x2="12" y2="18.4"/></svg>'
    };
    const cnt = page.counts[platform] || 0;
    return '<div class="platform-cell ' + (present ? 'present' : 'absent') + '">' +
      icons[platform] +
      '<span class="cnt">' + (present ? cnt : '—') + '</span>' +
      '</div>';
  }

  function stampHtml(coverage){
    if (coverage === 3) return '<span class="stamp full">Full RWD</span>';
    if (coverage === 2) return '<span class="stamp partial">Partial</span>';
    return '<span class="stamp single">Single</span>';
  }

  function pagesTableHtml(group, q){
    const pgs = visiblePagesFor(group, q);
    if (!pgs.length) {
      return '<p class="cp-panel-label">No pages match this filter for this success criterion.</p>';
    }
    const body = pgs.map(p => {
      const nameCell = escapeHtml(p.display) +
        (p.isSiteWide ? '<span class="page-tag">Site-wide</span>' : '') +
        (p.hasVariantMismatch ? '<span class="variant-flag" title="Appears with different spelling/casing across files: ' + escapeHtml(p.variants.join(' / ')) + '">&#9888;</span>' : '') +
        (p.checkpointLabels.length > 1 ? '<span class="cp-count-flag" title="Via ' + p.checkpointLabels.length + ' checkpoints: ' + escapeHtml(p.checkpointLabels.join(' / ')) + '">' + p.checkpointLabels.length + ' checkpoints</span>' : '');
      return '<tr>' +
        '<td class="page-name">' + nameCell + '</td>' +
        '<td class="col-platform">' + platformCellHtml(p, 'Desktop') + '</td>' +
        '<td class="col-platform">' + platformCellHtml(p, 'RWD Tablet') + '</td>' +
        '<td class="col-platform">' + platformCellHtml(p, 'RWD Mobile') + '</td>' +
        '<td class="col-coverage">' + stampHtml(p.coverage) + '</td>' +
        '<td class="col-issues"><span class="issues-count">' + p.totalRows + '</span></td>' +
        '</tr>';
    }).join('');

    return '<p class="cp-panel-label">' + pgs.length + ' page' + (pgs.length === 1 ? '' : 's') + ' affected by this success criterion</p>' +
      '<table class="checkpoint-table">' +
      '<thead><tr><th>Page</th><th class="col-platform">Desktop</th><th class="col-platform">RWD Tablet</th><th class="col-platform">RWD Mobile</th><th class="col-coverage">Coverage</th><th class="col-issues">Issues</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table>' +
      vpatBlocksHtml(group);
  }

  // All of this SC's VPAT remarks in ONE paste-ready field with a single Copy button:
  // one bullet per rule (the Generator's prose + the annotated page list), rendered in
  // Arial 11 so it pastes into the VPAT document as-is.
  function vpatBlocksHtml(group){
    const rules = (state.rulesBySc && state.rulesBySc.get(group.key)) || [];
    if (!rules.length) return '';
    const items = mergeRulesByText(rules).map(m => '<li>' + escapeHtml(vpatRemark(m)) + '</li>').join('');
    return '<div class="vpat-section">' +
      '<div class="vpat-block-head">' +
      '<span class="vpat-block-title">VPAT text</span>' +
      '<button class="btn ghost vpat-copy" type="button">Copy</button>' +
      '</div>' +
      '<ul class="vpat-text">' + items + '</ul>' +
      '</div>';
  }

  function scRowHtml(group, q){
    const nameCell = '<span class="sc-name">SC ' + escapeHtml(group.sc || '—') + '</span>' +
      (group.checkpointLabels.length > 1 ? '<span class="cp-count-flag" title="' + escapeHtml(group.checkpointLabels.join(' / ')) + '">' + group.checkpointLabels.length + ' checkpoints</span>' : '') +
      (group.group ? '<span class="sc-group-sub">' + escapeHtml(group.group) + '</span>' : '');

    const isExpanded = q ? true : state.expanded.has(group.key);

    const mainRow = '<tr>' +
      '<td class="col-expand"><button class="expand-btn" data-group-key="' + escapeHtml(group.key) + '" aria-expanded="' + isExpanded + '" aria-label="' + (isExpanded ? 'Collapse' : 'Expand') + ' pages for success criterion ' + escapeHtml(group.sc || '') + '"><svg viewBox="0 0 10 10" fill="currentColor"><path d="M2 0 L8 5 L2 10 Z"/></svg></button></td>' +
      '<td class="page-name">' + nameCell + '</td>' +
      '<td class="col-platform">' + platformCellHtml(group, 'Desktop') + '</td>' +
      '<td class="col-platform">' + platformCellHtml(group, 'RWD Tablet') + '</td>' +
      '<td class="col-platform">' + platformCellHtml(group, 'RWD Mobile') + '</td>' +
      '<td class="col-coverage">' + stampHtml(group.coverage) + '</td>' +
      '<td class="col-issues"><span class="issues-count">' + group.totalRows + '</span></td>' +
      '</tr>';

    const pageRow = isExpanded
      ? '<tr class="row-checkpoints"><td colspan="7">' + pagesTableHtml(group, q) + '</td></tr>'
      : '';

    return mainRow + pageRow;
  }

  function levelHeaderHtml(lvl, count){
    const collapsed = !!state.levelCollapsed[lvl];
    return '<tr class="level-row"><td colspan="7">' +
      '<button class="level-toggle" data-level="' + lvl + '" aria-expanded="' + (!collapsed) + '">' +
      '<svg class="level-chev" viewBox="0 0 10 10" fill="currentColor"><path d="M2 0 L8 5 L2 10 Z"/></svg>' +
      '<span class="level-name">' + LEVEL_LABEL[lvl] + '</span>' +
      '<span class="level-count">' + count + ' criteri' + (count === 1 ? 'on' : 'a') + '</span>' +
      '</button></td></tr>';
  }

  function renderTable(){
    const rows = getFilteredSorted();
    const tbody = document.getElementById('tableBody');
    const q = state.search ? state.search.toLowerCase() : '';

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:28px; color:var(--ink-soft);">No success criteria match this filter.</td></tr>';
      return;
    }

    // Partition the already-filtered/sorted SCs into WCAG level sections. Each level
    // gets its own collapse toggle; collapsing one simply omits that level's SC rows,
    // leaving the other level (and all counts/VPAT/closed filtering) untouched.
    const buckets = { A: [], AA: [], Other: [] };
    rows.forEach(g => { buckets[levelForSc(g.sc)].push(g); });

    let html = '';
    LEVEL_ORDER.forEach(lvl => {
      const list = buckets[lvl];
      if (!list.length) return;
      html += levelHeaderHtml(lvl, list.length);
      if (!state.levelCollapsed[lvl]) html += list.map(g => scRowHtml(g, q)).join('');
    });
    tbody.innerHTML = html;
  }

  function updateSortButtons(){
    document.querySelectorAll('.sortbtn').forEach(btn => {
      const key = btn.getAttribute('data-key');
      if (key === state.sort.key) {
        btn.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
      } else {
        btn.setAttribute('aria-sort', 'none');
      }
    });
  }

  function exportCsv(){
    const rows = getFilteredSorted();
    const header = ['Success Criteria', 'Checkpoint Group', 'Checkpoints Included', 'Desktop', 'Desktop Issues', 'RWD Tablet', 'RWD Tablet Issues', 'RWD Mobile', 'RWD Mobile Issues', 'Coverage', 'Total Issues', 'Pages Affected'];
    const lines = [header.join(',')];
    rows.forEach(g => {
      const cov = g.coverage === 3 ? 'Full (3/3)' : g.coverage === 2 ? 'Partial (2/3)' : 'Single (1/3)';
      const cells = [
        g.sc,
        g.group,
        g.checkpointLabels.join(' | '),
        g.platforms.has('Desktop') ? 'Yes' : 'No',
        g.counts['Desktop'],
        g.platforms.has('RWD Tablet') ? 'Yes' : 'No',
        g.counts['RWD Tablet'],
        g.platforms.has('RWD Mobile') ? 'Yes' : 'No',
        g.counts['RWD Mobile'],
        cov,
        g.totalRows,
        g.pages.length
      ].map(v => {
        const s = String(v);
        return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      });
      lines.push(cells.join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rwd-sc-summary.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    announce('Exported ' + rows.length + ' success criteria rows to CSV.');
  }

  function exportCheckpointsCsv(){
    // Full, unfiltered detail — one row per (Success Criteria, Page) combo regardless of current search/filter,
    // so nothing is lost even when the on-screen view is narrowed down.
    const header = ['Success Criteria', 'Checkpoint Group', 'Checkpoint', 'Page', 'Site-wide', 'Desktop', 'Desktop Issues', 'RWD Tablet', 'RWD Tablet Issues', 'RWD Mobile', 'RWD Mobile Issues', 'Coverage', 'Total Issues'];
    const lines = [header.join(',')];
    let count = 0;
    state.pages.forEach(page => {
      page.checkpoints.forEach(cp => {
        const cov = cp.coverage === 3 ? 'Full (3/3)' : cp.coverage === 2 ? 'Partial (2/3)' : 'Single (1/3)';
        const cells = [
          cp.sc,
          cp.group,
          cp.label,
          page.display,
          page.isSiteWide ? 'Yes' : 'No',
          cp.platforms.has('Desktop') ? 'Yes' : 'No',
          cp.counts['Desktop'],
          cp.platforms.has('RWD Tablet') ? 'Yes' : 'No',
          cp.counts['RWD Tablet'],
          cp.platforms.has('RWD Mobile') ? 'Yes' : 'No',
          cp.counts['RWD Mobile'],
          cov,
          cp.totalRows
        ].map(v => {
          const s = String(v);
          return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        });
        lines.push(cells.join(','));
        count++;
      });
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rwd-full-detail.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    announce('Exported ' + count + ' rows to CSV.');
  }

  // Copy rich HTML (so Word keeps the Arial 11 bullet list) with a plain-text bullet
  // fallback for editors/clipboards that don't take HTML.
  function copyRich(html, text, done){
    if (navigator.clipboard && window.ClipboardItem && navigator.clipboard.write) {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' })
      });
      navigator.clipboard.write([item]).then(done).catch(() => {
        if (navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
        else fallbackCopy(text, done);
      });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done){
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* no-op */ }
    document.body.removeChild(ta);
    if (done) done();
  }

  function downloadBlob(content, filename, type){
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Bulk export: every SC's VPAT remarks as bullets (rules with identical prose merged),
  // grouped by SC, in SC order.
  function exportVpatText(){
    if (!state.rulesBySc || !state.rulesBySc.size) { announce('No data to export.'); return; }
    const parts = [];
    let count = 0;
    state.rulesBySc.forEach(rules => {
      parts.push('SC ' + (rules[0].sc || '—'));
      mergeRulesByText(rules).forEach(m => { parts.push('• ' + vpatRemark(m)); count++; });
      parts.push('');
    });
    downloadBlob(parts.join('\n'), 'rwd-vpat-text.txt', 'text/plain;charset=utf-8;');
    announce('Exported ' + count + ' VPAT remarks.');
  }

  // ---------- Wiring ----------
  Object.keys(SOURCES).forEach(srcKey => {
    const cfg = SOURCES[srcKey];
    const input = document.getElementById(cfg.inputId);
    const dz = document.getElementById(cfg.dzId);

    input.addEventListener('change', e => {
      if (e.target.files && e.target.files[0]) handleFile(srcKey, e.target.files[0]);
    });
    dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('is-dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('is-dragover'));
    dz.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('is-dragover');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(srcKey, file);
    });
  });

  document.getElementById('searchInput').addEventListener('input', e => {
    state.search = e.target.value.trim();
    renderTable();
  });

  document.getElementById('includeClosed').addEventListener('change', e => {
    state.includeClosed = e.target.checked;
    recompute(); // re-filter from the raw rows so counts + VPAT text update immediately
  });

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
      chip.setAttribute('aria-pressed', 'true');
      state.tier = chip.getAttribute('data-tier');
      renderTable();
    });
  });

  document.querySelectorAll('.sortbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-key');
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.key = key;
        state.sort.dir = key === 'sc' ? 'asc' : 'desc';
      }
      updateSortButtons();
      renderTable();
    });
  });

  document.getElementById('exportBtn').addEventListener('click', exportCsv);
  document.getElementById('exportCheckpointsBtn').addEventListener('click', exportCheckpointsCsv);
  document.getElementById('exportVpatBtn').addEventListener('click', exportVpatText);

  document.getElementById('tableBody').addEventListener('click', e => {
    const copyBtn = e.target.closest('.vpat-copy');
    if (copyBtn) {
      const list = copyBtn.closest('.vpat-section').querySelector('.vpat-text');
      const remarks = list ? [...list.querySelectorAll('li')].map(li => li.textContent) : [];
      const text = remarks.map(r => '• ' + r).join('\n');
      const html = '<ul style="font-family:Arial,sans-serif;font-size:11pt;">' +
        remarks.map(r => '<li style="font-family:Arial,sans-serif;font-size:11pt;">' + escapeHtml(r) + '</li>').join('') +
        '</ul>';
      const done = () => { const t = copyBtn.textContent; copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = t; }, 1200); };
      copyRich(html, text, done);
      announce('Copied VPAT text to clipboard.');
      return;
    }
    const lvlBtn = e.target.closest('.level-toggle');
    if (lvlBtn) {
      const lvl = lvlBtn.getAttribute('data-level');
      state.levelCollapsed[lvl] = !state.levelCollapsed[lvl];
      renderTable();
      announce(LEVEL_LABEL[lvl] + (state.levelCollapsed[lvl] ? ' collapsed.' : ' expanded.'));
      return;
    }
    const btn = e.target.closest('.expand-btn');
    if (!btn) return;
    const key = btn.getAttribute('data-group-key');
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    renderTable();
  });

  document.getElementById('expandAllBtn').addEventListener('click', () => {
    state.scGroups.forEach(g => state.expanded.add(g.key));
    renderTable();
    announce('All success criteria expanded.');
  });

  document.getElementById('collapseAllBtn').addEventListener('click', () => {
    state.expanded.clear();
    renderTable();
    announce('All success criteria collapsed.');
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    state.files = { web: null, tablet: null, mobile: null };
    state.pages = [];
    state.scGroups = [];
    state.expanded.clear();
    state.includeClosed = false;
    state.levelCollapsed = { A: false, AA: false, Other: false };
    document.getElementById('includeClosed').checked = false;
    Object.keys(SOURCES).forEach(srcKey => {
      const cfg = SOURCES[srcKey];
      document.getElementById(cfg.inputId).value = '';
      document.getElementById(cfg.dzId).classList.remove('is-loaded', 'has-error');
      const statusEl = document.getElementById(cfg.statusId);
      statusEl.className = 'dz-status';
      statusEl.textContent = 'Drop file here or click to browse';
    });
    render();
    announce('All files cleared.');
  });

  updateSortButtons();
})();
