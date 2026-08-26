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
      checkpointGroup: 'Checkpoint Group',
      unitType: 'Unit Type',
      issueId: 'Issue ID',
      impact: 'Impact',
      description: 'Description'
    },
    siteWidePageName: 'project wide'
  };

  let CONFIG = DEFAULT_CONFIG;
  let PLATFORMS = [];

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

  // Platform parsing (Summary prefix -> platforms) and the whole page/rule model now live
  // in redistribute.js (RWDModel), shared with the regression test. This file keeps only
  // presentation + the shared-unit mapping UI.
  function applyConfig(cfg){
    CONFIG = cfg;
    PLATFORMS = cfg.platforms.slice();
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

  function emptyCounts(){
    const o = {};
    PLATFORMS.forEach(p => { o[p] = 0; });
    return o;
  }

  const state = {
    files: { web: null, tablet: null, mobile: null }, // { name, rows }
    pages: [],
    scGroups: [],
    sharedUnits: [],            // components + project-wide pages found in the uploads
    sharedMap: {},              // unitKey -> { mode:'all'|'pages'|'none', pages:[pageKey,...] } (persisted across recomputes)
    realPageKeys: [],           // page universe (real pages only) offered as mapping targets
    manualPages: [],            // hand-added zero-issue pages: [{ id, name, choice, platforms:[...] }] (persisted)
    manualSeq: 0,               // id generator for manual pages
    pendingManualName: null,    // name awaiting a platform choice (the "which platform?" step)
    projectWideExplicit: {},    // pageKey -> bool: user overrides of the auto project-wide marking (sticks)
    pwIssueMap: {},             // issueId -> { mode:'all'|'pages'|'none', pages:[pageKey,...] } (persisted)
    pageCatalog: [],            // every candidate page (real + project-wide + manual) for the mark grid
    projectWideKeys: [],        // currently-marked project-wide page keys
    pwSections: [],             // project-wide issues grouped into platform sections
    sort: { key: 'sc', dir: 'asc' },
    search: '',
    tier: 'all',
    includeClosed: false, // when false, "Closed" issues are ignored everywhere
    levelCollapsed: { A: false, AA: false, Other: false }, // WCAG level sections; false = expanded
    sectionCollapsed: { pagePresence: true, manual: true, mapping: true, projectWide: true },
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

  // Rebuild the whole model from the raw rows via the shared RWDModel (redistribute.js),
  // then reconcile the persisted mapping and refresh the mapping UI + results table.
  // `structural` = true when the set of shared units / pages may have changed (upload,
  // reset, Include-Closed toggle) so the mapping UI is re-rendered; a plain mapping edit
  // passes false so the user's in-progress checkboxes/radios are left untouched.
  function recompute(structural){
    const model = RWDModel.build({
      files: state.files,
      config: CONFIG,
      includeClosed: state.includeClosed,
      sharedMap: state.sharedMap,
      manualPages: state.manualPages.map(e => ({ name: e.name, platforms: e.platforms })),
      pwExplicit: state.projectWideExplicit,
      pwIssueMap: state.pwIssueMap
    });

    state.pages = model.pages;
    state.sharedUnits = model.sharedUnits;
    state.realPageKeys = model.realPageKeys;
    state.pageCatalog = model.pageCatalog;
    state.projectWideKeys = model.projectWideKeys;
    state.pwSections = model.pwSections;

    // Drop mapping entries for units that no longer exist; default any newly seen unit to
    // "not mapped" (mirrors the Conformance Calculator — nothing is redistributed until
    // you choose where it goes). Also prune page keys that are no longer in scope.
    const liveUnitKeys = new Set(state.sharedUnits.map(u => u.key));
    Object.keys(state.sharedMap).forEach(k => { if (!liveUnitKeys.has(k)) delete state.sharedMap[k]; });
    const livePageKeys = new Set(state.realPageKeys);
    state.sharedUnits.forEach(u => {
      if (!state.sharedMap[u.key]) state.sharedMap[u.key] = { mode: 'none', pages: [] };
      const sel = state.sharedMap[u.key];
      if (sel.pages && sel.pages.length) sel.pages = sel.pages.filter(pk => livePageKeys.has(pk));
    });

    // Prune project-wide state that no longer applies (pages/issues gone from the uploads).
    const liveCatalogKeys = new Set(state.pageCatalog.map(c => c.key));
    Object.keys(state.projectWideExplicit).forEach(k => { if (!liveCatalogKeys.has(k)) delete state.projectWideExplicit[k]; });
    const liveIssueIds = new Set();
    state.pwSections.forEach(s => s.issues.forEach(i => liveIssueIds.add(i.id)));
    Object.keys(state.pwIssueMap).forEach(id => { if (!liveIssueIds.has(id)) delete state.pwIssueMap[id]; });

    state.scGroups = buildScGroups(state.pages);

    // Rule-level VPAT groups (one paste-ready remark per rule), indexed by the same key
    // scGroups use (sc || checkpoint string) so each SC panel can show the VPAT text for
    // every rule it covers.
    state.ruleGroups = model.ruleGroups;
    state.rulesBySc = new Map();
    state.ruleGroups.forEach(rg => {
      const k = rg.sc || rg.checkpoint;
      if (!state.rulesBySc.has(k)) state.rulesBySc.set(k, []);
      state.rulesBySc.get(k).push(rg);
    });

    if (structural !== false) renderMapping();
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
            isManual: page.isManual,
            platforms: new Set(),
            counts: emptyCounts(),
            totalRows: 0,
            checkpointLabels: new Set(),
            sources: new Set() // shared units this SC's coverage on this page came from
          });
        }
        const gp = g.pages.get(page.key);
        gp.checkpointLabels.add(cp.label);
        gp.totalRows += cp.totalRows;
        (cp.sources || []).forEach(s => gp.sources.add(s));
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
        .map(p => ({ ...p, coverage: p.platforms.size, checkpointLabels: Array.from(p.checkpointLabels).sort(), sources: Array.from(p.sources).sort() }))
        .sort((a, b) => a.display.localeCompare(b.display))
    })).sort((a, b) => compareSC(a.sc, b.sc));
  }

  // ---------- VPAT text generation ----------
  // The actual sentence assembly lives in vpat-format.js (VPATFormat), shared with the
  // regression test so both run identical code. This file only prepares the merged data.

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

  // Delegate the actual VPAT sentence assembly to the shared module (see vpat-format.js).
  function vpatRemark(m){
    return VPATFormat.vpatRemark(m, PLATFORMS, CONFIG.vpatLabels);
  }

  // ---------- Shared-unit mapping UI (Section: components + project-wide pages) ----------
  const UNIT_BADGE = { component: 'Component', projectwide: 'Project-wide' };

  function unmappedCount(){
    return state.sharedUnits.filter(u => (state.sharedMap[u.key] || {}).mode !== 'all' &&
      !(((state.sharedMap[u.key] || {}).pages || []).length)).length;
  }

  function renderMapping(){
    const wrap = document.getElementById('mappingWrap');
    const list = document.getElementById('mappingList');
    if (!state.sharedUnits.length) {
      wrap.hidden = true;
      list.innerHTML = '';
      updateUnmappedBanner();
      return;
    }
    wrap.hidden = false;

    const realPages = state.pages.map(p => ({ key: p.key, display: p.display }))
      .sort((a, b) => a.display.localeCompare(b.display));

    list.innerHTML = state.sharedUnits.map(u => {
      const sel = state.sharedMap[u.key] || { mode: 'none', pages: [] };
      const selPages = new Set(sel.pages || []);
      const plats = u.platforms.length ? u.platforms.join(', ') : 'no platform detected';
      const scs = u.scList.length ? ('SC ' + u.scList.join(', ')) : 'no SC';
      const checks = realPages.map(pg =>
        '<label class="map-page' + (selPages.has(pg.key) ? ' on' : '') + '">' +
          '<input type="checkbox" class="map-page-cb" data-unit="' + escapeHtml(u.key) + '" data-page="' + escapeHtml(pg.key) + '"' +
          (selPages.has(pg.key) ? ' checked' : '') + (sel.mode === 'pages' ? '' : ' disabled') + ' /> ' +
          escapeHtml(pg.display) +
        '</label>'
      ).join('') || '<p class="map-empty">No real pages in scope yet — upload a CSV that contains page-type Test Units.</p>';

      return '<div class="mapping-unit" data-unit="' + escapeHtml(u.key) + '">' +
        '<div class="mapping-unit-head">' +
          '<span class="unit-badge ' + u.type + '">' + UNIT_BADGE[u.type] + '</span>' +
          '<span class="unit-name">' + escapeHtml(u.display) + '</span>' +
          '<span class="unit-meta">' + escapeHtml(plats) + '</span>' +
          '<span class="unit-meta soft">' + escapeHtml(scs) + '</span>' +
          '<span class="unit-meta soft">' + u.totalRows + ' issue' + (u.totalRows === 1 ? '' : 's') + '</span>' +
        '</div>' +
        '<div class="mapping-unit-controls" role="radiogroup" aria-label="Where does ' + escapeHtml(u.display) + ' apply?">' +
          radioHtml(u.key, 'all', 'All pages', sel.mode === 'all') +
          radioHtml(u.key, 'pages', 'Selected pages', sel.mode === 'pages') +
          radioHtml(u.key, 'none', 'Not mapped', sel.mode !== 'all' && sel.mode !== 'pages') +
        '</div>' +
        '<div class="mapping-unit-pages"' + (sel.mode === 'pages' ? '' : ' hidden') + '>' + checks + '</div>' +
      '</div>';
    }).join('');

    updateUnmappedBanner();
  }

  function radioHtml(unitKey, value, label, checked){
    return '<label class="map-mode"><input type="radio" name="mode-' + escapeHtml(unitKey) + '" class="map-mode-radio" ' +
      'data-unit="' + escapeHtml(unitKey) + '" value="' + value + '"' + (checked ? ' checked' : '') + ' /> ' + label + '</label>';
  }

  function updateUnmappedBanner(){
    const el = document.getElementById('mappingUnmapped');
    if (!el) return;
    const n = state.sharedUnits.length ? unmappedCount() : 0;
    if (!n) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = n + ' shared unit' + (n === 1 ? '' : 's') + ' not yet mapped — their issues are excluded from coverage below until you map them (or use “Map all → All pages”).';
  }

  // ---------- Add pages manually (zero-issue pages join the page universe) ----------
  function platformLabel(choice){ return choice === 'all' ? 'All 3 platforms' : choice; }
  function platformsForChoice(choice){ return choice === 'all' ? PLATFORMS.slice() : [choice]; }

  // Platforms a page is already present on (from CSV presence + earlier manual adds),
  // read from the last-computed model so duplicate checks see the real universe.
  function presenceForPageKey(key){
    const p = state.pages.find(pg => pg.key === key);
    return new Set(p && p.presence ? p.presence : []);
  }

  function manualMsg(text){
    const el = document.getElementById('manualMsg');
    if (!text){ el.hidden = true; el.textContent = ''; return; }
    el.hidden = false; el.textContent = text;
  }

  function showChooser(show){
    document.getElementById('manualChooser').hidden = !show;
    if (!show) state.pendingManualName = null;
  }

  // Step 1: validate the name, then ASK for the platform (don't add yet).
  function beginAddPage(){
    const input = document.getElementById('manualPageName');
    const name = (input.value || '').trim();
    manualMsg('');
    if (!name){ manualMsg('Please enter a page name.'); showChooser(false); input.focus(); return; }
    state.pendingManualName = name;
    showChooser(true);
    const first = document.querySelector('#manualChooser .chooser-opt');
    if (first) first.focus();
  }

  // Step 2: a platform was chosen — validate for duplicates, then add.
  function commitAddPage(choice){
    const name = state.pendingManualName;
    if (!name){ showChooser(false); return; }
    const key = name.toLowerCase();
    const chosen = platformsForChoice(choice);
    const present = presenceForPageKey(key);
    const isNew = chosen.filter(p => !present.has(p));
    if (!isNew.length){
      manualMsg('“' + name + '” is already present on ' + (choice === 'all' ? 'all 3 platforms' : choice) + '. Nothing added.');
      return;
    }
    state.manualPages.push({ id: ++state.manualSeq, name: name, choice: choice, platforms: chosen });
    document.getElementById('manualPageName').value = '';
    showChooser(false);
    manualMsg('');
    recompute(); // structural: the new page joins the universe + every mapping list
    announce('Added page ' + name + ' for ' + platformLabel(choice) + '.');
  }

  function removeManualPage(id){
    const idx = state.manualPages.findIndex(e => e.id === id);
    if (idx < 0) return;
    const removed = state.manualPages.splice(idx, 1)[0];
    recompute();
    announce('Removed page ' + removed.name + '.');
  }

  function renderManualPages(){
    document.getElementById('manualCount').textContent = state.manualPages.length + ' added';
    const list = document.getElementById('manualList');
    list.innerHTML = state.manualPages.map(e =>
      '<div class="manual-row">' +
        '<span class="manual-row-name">' + escapeHtml(e.name) + '</span>' +
        '<span class="manual-row-plat">' + escapeHtml(platformLabel(e.choice)) + '</span>' +
        '<button class="btn ghost manual-remove" type="button" data-id="' + e.id + '" aria-label="Remove ' + escapeHtml(e.name) + ' (' + escapeHtml(platformLabel(e.choice)) + ')">Remove</button>' +
      '</div>'
    ).join('');
  }

  function renderPagePresence(){
    const wrap = document.getElementById('pagePresenceWrap');
    const pages = state.pageCatalog || [];
    wrap.hidden = !pages.length;
    document.getElementById('pagePresenceCount').textContent = pages.length + ' page' + (pages.length === 1 ? '' : 's');
    document.getElementById('pagePresenceList').innerHTML = pages.map(page =>
      '<div class="page-presence-row">' +
        '<span class="page-presence-name">' + escapeHtml(page.display) + '</span>' +
        '<span class="page-presence-platforms">' + escapeHtml(page.presence.length ? page.presence.join(', ') : 'No platform presence recorded') + '</span>' +
      '</div>'
    ).join('');
  }

  function renderSectionToggles(){
    const sections = {
      pagePresence: 'pagePresenceBody',
      manual: 'manualBody',
      mapping: 'mappingBody',
      projectWide: 'projectWideBody'
    };
    Object.entries(sections).forEach(([key, bodyId]) => {
      const collapsed = !!state.sectionCollapsed[key];
      const body = document.getElementById(bodyId);
      const button = document.querySelector('.section-toggle[data-section="' + key + '"]');
      if (body) body.hidden = collapsed;
      if (button){
        const heading = button.closest('section').querySelector('h2').textContent;
        button.setAttribute('aria-expanded', String(!collapsed));
        button.setAttribute('aria-label', (collapsed ? 'Expand ' : 'Collapse ') + heading);
        button.setAttribute('title', collapsed ? 'Expand section' : 'Collapse section');
      }
    });
  }

  // ---------- 2b. Project-wide / app-wide pages ----------
  function sevClass(impact){
    const s = (impact || '').toLowerCase();
    if (/blocker|critical/.test(s)) return 'sev-critical';
    if (/serious|high/.test(s)) return 'sev-serious';
    if (/moderate|medium/.test(s)) return 'sev-moderate';
    if (/minor|low/.test(s)) return 'sev-minor';
    return 'sev-none';
  }

  // Current mapped page keys for an issue, from the last-computed model (so an "All pages"
  // issue expands to the full applicable list before a single page is unticked).
  function currentIssueSelection(id){
    for (const sec of state.pwSections){
      const iss = sec.issues.find(i => i.id === id);
      if (iss) return new Set(iss.mappedPageKeys);
    }
    return new Set();
  }
  function issueApplicablePages(id){
    for (const sec of state.pwSections){
      if (sec.issues.some(i => i.id === id)) return sec.applicablePages;
    }
    return [];
  }

  function renderPwIssue(sec, iss){
    const mapped = new Set(iss.mappedPageKeys);
    const on = k => (iss.mode === 'all' || mapped.has(k));
    const checks = sec.applicablePages.length
      ? sec.applicablePages.map(pg =>
          '<label class="pw-page' + (on(pg.key) ? ' on' : '') + '">' +
            '<input type="checkbox" class="pw-page-cb" data-issue="' + escapeHtml(iss.id) + '" data-page="' + escapeHtml(pg.key) + '"' + (on(pg.key) ? ' checked' : '') + ' /> ' +
            escapeHtml(pg.display) +
          '</label>'
        ).join('')
      : '<p class="pw-empty">No applicable pages for this platform yet — add one under &ldquo;Add pages manually&rdquo;.</p>';
    return '<div class="pw-issue" data-issue="' + escapeHtml(iss.id) + '">' +
      '<div class="pw-issue-head">' +
        '<span class="pw-issue-id">' + escapeHtml(iss.id) + '</span>' +
        (iss.impact ? '<span class="pw-sev ' + sevClass(iss.impact) + '">' + escapeHtml(iss.impact) + '</span>' : '') +
        (iss.sc ? '<span class="pw-sc">' + escapeHtml(iss.sc) + '</span>' : '') +
        (iss.platforms.length ? '<span class="pw-issue-plats">' + escapeHtml(iss.platforms.join(', ')) + '</span>' : '') +
        '<span class="pw-issue-count">' + iss.mappedCount + ' / ' + iss.applicableCount + ' pages</span>' +
      '</div>' +
      (iss.desc ? '<p class="pw-issue-desc">' + escapeHtml(iss.desc) + '</p>' : '') +
      '<div class="pw-issue-controls">' +
        '<button class="btn ghost pw-all" type="button" data-issue="' + escapeHtml(iss.id) + '">All pages (' + iss.applicableCount + ')</button>' +
        '<button class="btn ghost pw-clear" type="button" data-issue="' + escapeHtml(iss.id) + '">Clear</button>' +
      '</div>' +
      '<div class="pw-issue-filter">' +
        '<textarea class="pw-filter" data-issue="' + escapeHtml(iss.id) + '" placeholder="Filter, or paste one page per line to select…" rows="2" aria-label="Filter or paste pages for issue ' + escapeHtml(iss.id) + '"></textarea>' +
        '<button class="btn pw-selectmatches" type="button" data-issue="' + escapeHtml(iss.id) + '">Select matches</button>' +
      '</div>' +
      '<div class="pw-issue-pages">' + checks + '</div>' +
    '</div>';
  }

  function renderPwSection(sec){
    return '<div class="pw-section">' +
      '<div class="pw-section-head">' +
        '<span class="pw-section-title">Project Wide &mdash; ' + escapeHtml(sec.label) + '</span>' +
        '<span class="pw-section-meta">project-wide &middot; ' + sec.issueCount + ' issue' + (sec.issueCount === 1 ? '' : 's') + ' &middot; ' + sec.unmappedCount + ' unmapped</span>' +
      '</div>' +
      sec.issues.map(iss => renderPwIssue(sec, iss)).join('') +
    '</div>';
  }

  function renderProjectWide(){
    const wrap = document.getElementById('pwWrap');
    const cat = state.pageCatalog || [];
    if (!cat.length){ wrap.hidden = true; return; }
    wrap.hidden = false;

    document.getElementById('pwMarkCount').textContent =
      state.projectWideKeys.length + ' selected · removed from page count';
    document.getElementById('pwMarkGrid').innerHTML = cat.map(c =>
      '<label class="pw-mark-item' + (c.selected ? ' on' : '') + '">' +
        '<input type="checkbox" class="pw-mark-cb" data-key="' + escapeHtml(c.key) + '"' + (c.selected ? ' checked' : '') + ' /> ' +
        escapeHtml(c.display) +
        (c.auto ? '<span class="pw-auto" title="Auto-detected from the page name">auto</span>' : '') +
      '</label>'
    ).join('');

    const secWrap = document.getElementById('pwSections');
    secWrap.innerHTML = state.pwSections.length
      ? state.pwSections.map(renderPwSection).join('')
      : '<p class="pw-empty">No pages are marked project-wide. Tick a page above to map its issues onto the real pages where they reproduce.</p>';
  }

  function render(){
    const loadedCount = Object.values(state.files).filter(Boolean).length;
    const hasAny = loadedCount > 0;

    document.getElementById('emptyState').hidden = hasAny;
    document.getElementById('stats').hidden = !hasAny;
    document.getElementById('toolbar').hidden = !hasAny;
    document.getElementById('tableWrap').hidden = !hasAny;
    document.getElementById('manualWrap').hidden = !hasAny;
    renderPagePresence();
    renderSectionToggles();
    if (hasAny) renderManualPages(); else { showChooser(false); manualMsg(''); }
    if (hasAny) renderProjectWide(); else document.getElementById('pwWrap').hidden = true;
    if (!hasAny) document.getElementById('mappingWrap').hidden = true;

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
        (p.isManual ? '<span class="page-tag manual">Added</span>' : '') +
        ((p.sources && p.sources.length) ? '<span class="via-flag" title="Coverage on this page redistributed from shared unit(s): ' + escapeHtml(p.sources.join(' / ')) + '">via ' + escapeHtml(p.sources.join(', ')) + '</span>' : '') +
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
    const header = ['Success Criteria', 'Checkpoint Group', 'Checkpoint', 'Page', 'Site-wide', 'Redistributed From', 'Desktop', 'Desktop Issues', 'RWD Tablet', 'RWD Tablet Issues', 'RWD Mobile', 'RWD Mobile Issues', 'Coverage', 'Total Issues'];
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
          (cp.sources && cp.sources.length) ? cp.sources.join(' | ') : '',
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

  // Shared-unit mapping. Radio = mode; checkboxes = which pages when mode is "Selected
  // pages". A mapping edit re-runs the model (recompute) but NOT the mapping UI itself
  // (structural=false), so in-progress radios/checkboxes keep their focus and state.
  const mappingList = document.getElementById('mappingList');
  mappingList.addEventListener('change', e => {
    const radio = e.target.closest('.map-mode-radio');
    if (radio) {
      const unit = radio.getAttribute('data-unit');
      const mode = radio.value;
      const sel = state.sharedMap[unit] || (state.sharedMap[unit] = { mode: 'none', pages: [] });
      sel.mode = mode;
      // Show/hide this unit's page checkboxes and enable/disable them in place.
      const unitEl = radio.closest('.mapping-unit');
      const pagesEl = unitEl && unitEl.querySelector('.mapping-unit-pages');
      if (pagesEl) {
        pagesEl.hidden = mode !== 'pages';
        pagesEl.querySelectorAll('.map-page-cb').forEach(cb => { cb.disabled = mode !== 'pages'; });
      }
      recompute(false);
      announce(radio.closest('.mapping-unit').querySelector('.unit-name').textContent + ' mapping: ' + radio.parentNode.textContent.trim() + '.');
      return;
    }
    const cb = e.target.closest('.map-page-cb');
    if (cb) {
      const unit = cb.getAttribute('data-unit');
      const page = cb.getAttribute('data-page');
      const sel = state.sharedMap[unit] || (state.sharedMap[unit] = { mode: 'pages', pages: [] });
      const set = new Set(sel.pages || []);
      if (cb.checked) set.add(page); else set.delete(page);
      sel.pages = Array.from(set);
      cb.closest('.map-page').classList.toggle('on', cb.checked);
      recompute(false);
      return;
    }
  });

  // Add pages manually
  document.getElementById('addPageBtn').addEventListener('click', beginAddPage);
  document.getElementById('manualPageName').addEventListener('keydown', e => {
    if (e.key === 'Enter'){ e.preventDefault(); beginAddPage(); }
  });
  document.getElementById('chooserCancel').addEventListener('click', () => { showChooser(false); manualMsg(''); });
  document.querySelectorAll('#manualChooser .chooser-opt').forEach(btn => {
    btn.addEventListener('click', () => commitAddPage(btn.getAttribute('data-choice')));
  });
  document.getElementById('manualList').addEventListener('click', e => {
    const rm = e.target.closest('.manual-remove');
    if (rm) removeManualPage(parseInt(rm.getAttribute('data-id'), 10));
  });

  // Project-wide 2b: mark grid + per-issue mapping.
  const pwWrap = document.getElementById('pwWrap');
  pwWrap.addEventListener('change', e => {
    const markCb = e.target.closest('.pw-mark-cb');
    if (markCb){
      state.projectWideExplicit[markCb.getAttribute('data-key')] = markCb.checked;
      recompute(true);
      return;
    }
    const pageCb = e.target.closest('.pw-page-cb');
    if (pageCb){
      const id = pageCb.getAttribute('data-issue');
      const key = pageCb.getAttribute('data-page');
      const sel = currentIssueSelection(id);
      if (pageCb.checked) sel.add(key); else sel.delete(key);
      state.pwIssueMap[id] = { mode: 'pages', pages: Array.from(sel) };
      recompute(true);
      return;
    }
  });
  pwWrap.addEventListener('click', e => {
    const allBtn = e.target.closest('.pw-all');
    if (allBtn){
      const id = allBtn.getAttribute('data-issue');
      state.pwIssueMap[id] = { mode: 'all', pages: [] };
      recompute(true);
      announce('Issue ' + id + ' mapped to all applicable pages.');
      return;
    }
    const clrBtn = e.target.closest('.pw-clear');
    if (clrBtn){
      const id = clrBtn.getAttribute('data-issue');
      state.pwIssueMap[id] = { mode: 'none', pages: [] };
      recompute(true);
      announce('Issue ' + id + ' mapping cleared.');
      return;
    }
    const smBtn = e.target.closest('.pw-selectmatches');
    if (smBtn){
      const id = smBtn.getAttribute('data-issue');
      const block = smBtn.closest('.pw-issue');
      const ta = block && block.querySelector('.pw-filter');
      const queries = ((ta && ta.value) || '').split(/[\n,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
      if (!queries.length) return;
      const apps = issueApplicablePages(id);
      const sel = currentIssueSelection(id);
      let n = 0;
      apps.forEach(pg => {
        const d = pg.display.toLowerCase();
        if (queries.some(q => d === q || d.includes(q))){ if (!sel.has(pg.key)){ sel.add(pg.key); n++; } }
      });
      state.pwIssueMap[id] = { mode: 'pages', pages: Array.from(sel) };
      recompute(true);
      announce(n + ' page' + (n === 1 ? '' : 's') + ' selected for issue ' + id + '.');
      return;
    }
  });

  document.getElementById('mapAllBtn').addEventListener('click', () => {
    if (!state.sharedUnits.length) return;
    state.sharedUnits.forEach(u => { state.sharedMap[u.key] = { mode: 'all', pages: [] }; });
    recompute(true); // re-render the mapping UI so every radio reflects "All pages"
    announce('All shared units mapped to All pages.');
  });

  document.querySelectorAll('.section-toggle').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.getAttribute('data-section');
      state.sectionCollapsed[key] = !state.sectionCollapsed[key];
      renderSectionToggles();
      announce((state.sectionCollapsed[key] ? 'Collapsed ' : 'Expanded ') + key.replace(/([A-Z])/g, ' $1').toLowerCase() + ' section.');
    });
  });

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
    state.sectionCollapsed = { pagePresence: true, manual: true, mapping: true, projectWide: true };
    renderTable();
    announce('All success criteria collapsed.');
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    state.files = { web: null, tablet: null, mobile: null };
    state.pages = [];
    state.scGroups = [];
    state.sharedUnits = [];
    state.sharedMap = {};
    state.realPageKeys = [];
    state.manualPages = [];
    state.manualSeq = 0;
    state.pendingManualName = null;
    state.projectWideExplicit = {};
    state.pwIssueMap = {};
    state.pageCatalog = [];
    state.projectWideKeys = [];
    state.pwSections = [];
    document.getElementById('manualPageName').value = '';
    showChooser(false);
    manualMsg('');
    document.getElementById('pwWrap').hidden = true;
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
    renderMapping();
    render();
    announce('All files cleared.');
  });

  updateSortButtons();
})();
