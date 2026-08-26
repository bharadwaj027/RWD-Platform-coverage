// Coverage model builder — the single source of truth for turning the uploaded axe
// Auditor rows into the page/rule model the UI renders. Kept DOM-free and framework-free
// (like vpat-format.js) so the browser tool (script.js) and the Node/browser regression
// test run the exact same code.
//
// Two kinds of shared findings never appear as pages of their own:
//   * COMPONENTS (Unit Type = Component) — mapped as a whole to their pages (All / Selected
//     pages / Not mapped). Every mapped page inherits the component's platforms.
//   * PROJECT-WIDE / APP-WIDE pages — any page the user marks in the "Mark project-wide
//     pages" grid (name-matching pages are auto-marked). Each of their ISSUES is mapped
//     individually to the real pages where it reproduces, and issues are grouped into
//     platform-specific sections (Desktop / RWD Tablet / RWD Mobile / RWD Platforms /
//     All Platforms) by the platform(s) the issue applies to.
//
// In BOTH cases a platform is only ever added to a target page when that page is present in
// that platform's CSV (page.presence) — so a shared finding on RWD Mobile is never claimed
// on a page that was not audited on RWD Mobile. Pages are never duplicated (platform unions
// are idempotent). The complete page universe — CSV pages + manually added pages, each with
// its platform presence — is the single source of truth for every mapping list and count.
;(function (root) {
  'use strict';

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ["Desktop","RWD Tablet"] -> case-insensitive alternation tolerating odd whitespace.
  // Matches a leading platform list terminated by EITHER a colon ("Desktop, RWD Tablet: …")
  // OR a spaced dash ("Desktop, RWD Tablet - …") — axe Auditor exports use the dash form,
  // while some sources use the colon form; both mean the same thing. The dash branch
  // requires whitespace on both sides so ordinary hyphenated text ("RWD Mobile-only …")
  // is NOT mistaken for a platform prefix.
  function buildPrefixRegex(platforms) {
    var alt = platforms
      .map(function (p) { return p.trim().split(/\s+/).map(escapeRegex).join('\\s*'); })
      .join('|');
    return new RegExp('^\\s*((?:' + alt + ')(?:\\s*,\\s*(?:' + alt + '))*)(?:\\s*:\\s*|\\s+-\\s+)', 'i');
  }

  function buildPlatformLookup(platforms) {
    var map = {};
    platforms.forEach(function (p) { map[p.trim().replace(/\s+/g, ' ').toLowerCase()] = p; });
    return map;
  }

  // Numeric-aware Success Criteria comparison ("1.4.10" sorts after "1.4.3").
  function compareSC(a, b) {
    var pa = String(a || '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
    var pb = String(b || '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  function unitKeyFor(type, name) {
    return type + ':' + String(name || '').trim().toLowerCase();
  }

  // A page name looks project-wide/app-wide (auto-marked in the grid).
  var PW_NAME_RE = /(project|app)[\s_-]*wide/i;

  // Classify a set of platforms into a project-wide section bucket.
  function classifyBucket(platformsArr, PLATFORMS) {
    var s = {};
    platformsArr.forEach(function (p) { s[p] = true; });
    var hasD = !!s['Desktop'], hasT = !!s['RWD Tablet'], hasM = !!s['RWD Mobile'];
    var count = platformsArr.length;
    if (hasD && hasT && hasM) return { key: 'all', label: 'All Platforms', order: 5, platforms: PLATFORMS.slice() };
    if (!hasD && hasT && hasM) return { key: 'rwd', label: 'RWD Platforms', order: 4, platforms: ['RWD Tablet', 'RWD Mobile'] };
    if (count === 1) {
      if (hasD) return { key: 'desktop', label: 'Desktop', order: 1, platforms: ['Desktop'] };
      if (hasT) return { key: 'tablet', label: 'RWD Tablet', order: 2, platforms: ['RWD Tablet'] };
      if (hasM) return { key: 'mobile', label: 'RWD Mobile', order: 3, platforms: ['RWD Mobile'] };
    }
    // Any other mix (e.g. Desktop + RWD Tablet, or no platform detected).
    var plats = PLATFORMS.filter(function (p) { return s[p]; });
    return { key: 'mix:' + plats.join('+'), label: plats.join(' + ') || 'Unspecified', order: 6, platforms: plats };
  }

  // Build the whole model.
  //   opts = {
  //     files: { web:{rows}|null, tablet:{...}, mobile:{...} },
  //     config: CONFIG (platforms, columns, sourceDefaults, siteWidePageName, ...),
  //     includeClosed: bool,
  //     sharedMap: { [componentKey]: { mode:'all'|'pages'|'none', pages:[pageKey,...] } },
  //     manualPages: [ { name, platforms:['Desktop', ...] } ],
  //     pwExplicit: { [pageKey]: bool },              // user overrides of the auto project-wide marking
  //     pwIssueMap: { [issueId]: { mode:'all'|'pages'|'none', pages:[pageKey,...] } }
  //   }
  function build(opts) {
    opts = opts || {};
    var cfg = opts.config;
    var PLATFORMS = cfg.platforms.slice();
    var COLS = cfg.columns;
    var SOURCE_KEYS = ['web', 'tablet', 'mobile'];
    var PREFIX_RE = buildPrefixRegex(PLATFORMS);
    var LOOKUP = buildPlatformLookup(PLATFORMS);
    var siteWide = (cfg.siteWidePageName || '').toString().trim().toLowerCase();
    var includeClosed = !!opts.includeClosed;
    var sharedMap = opts.sharedMap || {};
    var files = opts.files || {};
    var manualPages = opts.manualPages || [];
    var pwExplicit = opts.pwExplicit || {};
    var pwIssueMap = opts.pwIssueMap || {};

    // Platform AVAILABILITY of a page ("which platforms does this page exist on?") is kept
    // separate from issue APPLICABILITY ("which platforms does this issue occur on?"). A
    // CSV pages carry the platforms of the exports where they appear. Manually added pages
    // instead carry the exact platforms the user chose. When an issue/component is mapped to
    // a page, the platforms actually recorded are the INTERSECTION of the two (see
    // `surviving`), so an issue's platforms are preserved and never expanded by the target.
    function emptyCounts() { var o = {}; PLATFORMS.forEach(function (p) { o[p] = 0; }); return o; }
    function normalizeToken(t) { var c = t.trim().replace(/\s+/g, ' ').toLowerCase(); return LOOKUP[c] || t.trim(); }
    function platformsOf(summary, def) {
      var m = String(summary || '').match(PREFIX_RE);
      var toks = m ? m[1].split(',').map(normalizeToken) : [def];
      return toks.filter(function (t) { return PLATFORMS.indexOf(t) >= 0; });
    }

    var pagesMap = new Map();     // real (non-project-wide) pages
    var rulesMap = new Map();     // real rules (VPAT)
    var componentsMap = new Map();// components (shared units mapped as a whole)
    var catalog = new Map();      // EVERY page-type Test Unit + manual pages -> mark-grid candidate + presence
    var pageBuffer = [];          // buffered page-type issue rows, processed once the PW set is known

    function ensurePage(key, display) {
      if (!pagesMap.has(key)) {
        pagesMap.set(key, {
          display: display, variants: new Set(), platforms: new Set(), presence: new Set(),
          counts: emptyCounts(), totalRows: 0, redistributedFrom: new Set(), isManual: false, fromCsv: false, checkpoints: new Map()
        });
      }
      return pagesMap.get(key);
    }
    function ensureCatalog(key, display) {
      if (!catalog.has(key)) catalog.set(key, { display: display, presence: new Set(), isManual: false });
      return catalog.get(key);
    }
    function ensureCheckpoint(container, cpKey, cpLabel, sc, group) {
      if (!container.has(cpKey)) {
        container.set(cpKey, { label: cpLabel, sc: sc, group: group, platforms: new Set(), counts: emptyCounts(), totalRows: 0, sources: new Set() });
      }
      return container.get(cpKey);
    }
    function ensureRule(ruleKey, ruleId, sc, cpLabel) {
      if (!rulesMap.has(ruleKey)) rulesMap.set(ruleKey, { ruleId: ruleId, sc: sc, checkpoint: cpLabel, pages: new Map() });
      return rulesMap.get(ruleKey);
    }

    // ---- Pass 1: read rows. Components accumulate now; page rows buffer for pass 2. ----
    SOURCE_KEYS.forEach(function (srcKey) {
      var data = files[srcKey];
      if (!data) return;
      var defaultPlatform = cfg.sourceDefaults[srcKey];

      data.rows.forEach(function (row) {
        if (!includeClosed) {
          var status = (row[COLS.issueStatus] || '').toString().trim().toLowerCase();
          if (status === 'closed') return;
        }
        var pageRaw = (row[COLS.page] || '').toString().trim();
        if (!pageRaw) return;
        var key = pageRaw.toLowerCase();
        var unitTypeRaw = (COLS.unitType && row[COLS.unitType] != null) ? String(row[COLS.unitType]) : '';
        var isComponent = /component/i.test(unitTypeRaw);
        var tokens = platformsOf(row[COLS.summary], defaultPlatform);
        var cpLabel = (row[COLS.checkpoint] || row[COLS.successCriteria] || 'Unspecified checkpoint').toString().trim();
        var cpKey = cpLabel.toLowerCase();
        var sc = (row[COLS.successCriteria] || '').toString().trim();
        var group = (row[COLS.checkpointGroup] || '').toString().trim();
        var ruleId = (row[COLS.ruleId] || '').toString().trim();
        var ruleKey = ruleId ? 'rid:' + ruleId.toLowerCase() : 'cp:' + cpKey;

        if (isComponent) {
          var uKey = unitKeyFor('component', pageRaw);
          var u = componentsMap.get(uKey);
          if (!u) { u = { key: uKey, display: pageRaw, type: 'component', platforms: new Set(), totalRows: 0, scSet: new Set(), checkpoints: new Map(), rules: new Map() }; componentsMap.set(uKey, u); }
          u.totalRows += 1; if (sc) u.scSet.add(sc);
          var ucp = ensureCheckpoint(u.checkpoints, cpKey, cpLabel, sc, group);
          ucp.totalRows += 1;
          tokens.forEach(function (t) { u.platforms.add(t); ucp.platforms.add(t); ucp.counts[t] += 1; });
          if (!u.rules.has(ruleKey)) u.rules.set(ruleKey, { ruleId: ruleId, sc: sc, checkpoint: cpLabel, platforms: new Set() });
          var urule = u.rules.get(ruleKey);
          tokens.forEach(function (t) { urule.platforms.add(t); });
          return;
        }

        // page-type row -> catalog + buffer
        var cat = ensureCatalog(key, pageRaw);
        cat.presence.add(defaultPlatform);
        var idRaw = (COLS.issueId && row[COLS.issueId] != null) ? String(row[COLS.issueId]).trim() : '';
        var impact = (COLS.impact && row[COLS.impact] != null) ? String(row[COLS.impact]).trim() : '';
        var desc = (COLS.description && row[COLS.description] != null) ? String(row[COLS.description]).trim() : '';
        if (!desc) desc = (row[COLS.summary] || '').toString().trim();
        pageBuffer.push({
          key: key, display: pageRaw, srcDefault: defaultPlatform, tokens: tokens,
          cpLabel: cpLabel, cpKey: cpKey, sc: sc, group: group, ruleId: ruleId, ruleKey: ruleKey,
          id: idRaw, impact: impact, desc: desc
        });
      });
    });

    // ---- Manual pages -> catalog (presence from the chosen platforms) ----
    manualPages.forEach(function (mp) {
      var name = (mp && mp.name != null ? String(mp.name) : '').trim();
      if (!name) return;
      var cat = ensureCatalog(name.toLowerCase(), name);
      cat.isManual = true;
      (mp.platforms || []).forEach(function (t) { if (PLATFORMS.indexOf(t) >= 0) cat.presence.add(t); });
    });

    // ---- Resolve which catalog pages are project-wide (auto by name, user override wins) ----
    var pwSet = new Set();
    var pageCatalog = [];
    catalog.forEach(function (cat, key) {
      var auto = PW_NAME_RE.test(cat.display) || key === siteWide;
      var selected = Object.prototype.hasOwnProperty.call(pwExplicit, key) ? !!pwExplicit[key] : auto;
      if (selected) pwSet.add(key);
      pageCatalog.push({
        key: key, display: cat.display, isManual: cat.isManual, auto: auto, selected: selected,
        presence: PLATFORMS.filter(function (p) { return cat.presence.has(p); })
      });
    });
    pageCatalog.sort(function (a, b) { return a.display.localeCompare(b.display); });

    // ---- Pass 2: buffered page rows -> real pages (or project-wide issues) ----
    var pwIssues = [];
    var pwAutoId = 0;
    pageBuffer.forEach(function (b) {
      if (pwSet.has(b.key)) {
        var id = b.id || ('auto:' + b.key + '|' + b.cpKey + '|' + (++pwAutoId));
        pwIssues.push({
          id: id, page: b.display, pageKey: b.key, impact: b.impact, sc: b.sc, desc: b.desc,
          platforms: b.tokens.slice(), cpLabel: b.cpLabel, cpKey: b.cpKey, group: b.group,
          ruleId: b.ruleId, ruleKey: b.ruleKey
        });
        return;
      }
      var p = ensurePage(b.key, b.display);
      p.variants.add(b.display);
      p.totalRows += 1;
      p.fromCsv = true; // availability comes from the CSVs where this page appears
      p.presence.add(b.srcDefault);
      b.tokens.forEach(function (t) { p.platforms.add(t); p.counts[t] += 1; });
      var cp = ensureCheckpoint(p.checkpoints, b.cpKey, b.cpLabel, b.sc, b.group);
      cp.totalRows += 1;
      b.tokens.forEach(function (t) { cp.platforms.add(t); cp.counts[t] += 1; });
      var rg = ensureRule(b.ruleKey, b.ruleId, b.sc, b.cpLabel);
      if (!rg.pages.has(b.key)) rg.pages.set(b.key, { display: b.display, platforms: new Set() });
      var rgp = rg.pages.get(b.key);
      b.tokens.forEach(function (t) { rgp.platforms.add(t); });
    });

    // ---- Manual pages that are NOT project-wide become real (zero-issue) pages ----
    manualPages.forEach(function (mp) {
      var name = (mp && mp.name != null ? String(mp.name) : '').trim();
      if (!name) return;
      var key = name.toLowerCase();
      if (pwSet.has(key)) return;
      var p = ensurePage(key, name);
      (mp.platforms || []).forEach(function (t) { if (PLATFORMS.indexOf(t) >= 0) p.presence.add(t); });
      p.isManual = true;
    });

    var realPageKeys = Array.from(pagesMap.keys());

    // ---- Redistribution primitives (presence-gated) ----
    function surviving(platformSet, page) {
      return PLATFORMS.filter(function (t) { return platformSet.has(t) && page.presence.has(t); });
    }
    // A single (sc/checkpoint, platforms) failure onto one page, credited to `source`.
    function applyFailure(pageKey, cpKey, cpLabel, sc, group, ruleKey, ruleId, platformSet, source) {
      var p = pagesMap.get(pageKey);
      if (!p) return false;
      var keep = surviving(platformSet, p);
      if (!keep.length) return false;
      var cp = ensureCheckpoint(p.checkpoints, cpKey, cpLabel, sc, group);
      cp.sources.add(source);
      cp.totalRows += 1; p.totalRows += 1;
      keep.forEach(function (t) { cp.platforms.add(t); p.platforms.add(t); cp.counts[t] += 1; p.counts[t] += 1; });
      p.redistributedFrom.add(source);
      var rg = ensureRule(ruleKey, ruleId, sc, cpLabel);
      if (!rg.pages.has(pageKey)) rg.pages.set(pageKey, { display: p.display, platforms: new Set() });
      var rgp = rg.pages.get(pageKey);
      keep.forEach(function (t) { rgp.platforms.add(t); });
      return true;
    }

    // ---- Components (mapped as a whole) ----
    var sharedUnits = [];
    componentsMap.forEach(function (u) {
      var sel = sharedMap[u.key] || { mode: 'none', pages: [] };
      var targets = sel.mode === 'all' ? realPageKeys.slice() : sel.mode === 'pages' ? (sel.pages || []).filter(function (k) { return pagesMap.has(k); }) : [];
      targets.forEach(function (tk) {
        var p = pagesMap.get(tk); if (!p) return;
        var addedAny = false;
        u.checkpoints.forEach(function (ucp, cpKey) {
          var keep = surviving(ucp.platforms, p);
          if (!keep.length) return;
          var cp = ensureCheckpoint(p.checkpoints, cpKey, ucp.label, ucp.sc, ucp.group);
          cp.sources.add(u.display);
          cp.totalRows += ucp.totalRows; p.totalRows += ucp.totalRows;
          keep.forEach(function (t) { cp.platforms.add(t); p.platforms.add(t); cp.counts[t] += ucp.counts[t]; p.counts[t] += ucp.counts[t]; });
          addedAny = true;
        });
        if (addedAny) p.redistributedFrom.add(u.display);
        u.rules.forEach(function (ur, ruleKey) {
          var keep = surviving(ur.platforms, p);
          if (!keep.length) return;
          var rg = ensureRule(ruleKey, ur.ruleId, ur.sc, ur.checkpoint);
          if (!rg.pages.has(tk)) rg.pages.set(tk, { display: p.display, platforms: new Set() });
          var rgp = rg.pages.get(tk);
          keep.forEach(function (t) { rgp.platforms.add(t); });
        });
      });
      sharedUnits.push({
        key: u.key, display: u.display, type: 'component',
        platforms: PLATFORMS.filter(function (p) { return u.platforms.has(p); }),
        scList: Array.from(u.scSet).sort(compareSC), checkpointCount: u.checkpoints.size,
        totalRows: u.totalRows, mode: sel.mode || 'none', mappedPageKeys: targets.slice()
      });
    });
    sharedUnits.sort(function (a, b) { return a.display.localeCompare(b.display); });

    // ---- Real-page universe (for project-wide issue mapping targets), with presence ----
    var universe = Array.from(pagesMap.entries()).map(function (e) {
      return { key: e[0], display: e[1].display, presence: e[1].presence };
    });
    function applicablePagesFor(platformsArr) {
      var set = {}; platformsArr.forEach(function (p) { set[p] = true; });
      return universe
        .filter(function (pg) { return PLATFORMS.some(function (t) { return set[t] && pg.presence.has(t); }); })
        .map(function (pg) { return { key: pg.key, display: pg.display }; })
        .sort(function (a, b) { return a.display.localeCompare(b.display); });
    }

    // ---- Project-wide issues: classify, map, redistribute ----
    var sectionMap = new Map(); // bucketKey -> section
    pwIssues.forEach(function (iss) {
      var bucket = classifyBucket(iss.platforms, PLATFORMS);
      var sec = sectionMap.get(bucket.key);
      if (!sec) {
        sec = { key: bucket.key, label: bucket.label, order: bucket.order, platforms: bucket.platforms.slice(), issues: [], applicablePages: applicablePagesFor(bucket.platforms) };
        sectionMap.set(bucket.key, sec);
      }
      var applicableKeys = sec.applicablePages.map(function (p) { return p.key; });
      var applicableSet = new Set(applicableKeys);
      var sel = pwIssueMap[iss.id] || { mode: 'none', pages: [] };
      var targets = sel.mode === 'all' ? applicableKeys.slice()
        : sel.mode === 'pages' ? (sel.pages || []).filter(function (k) { return applicableSet.has(k); })
        : [];
      var platSet = new Set(iss.platforms);
      targets.forEach(function (tk) { applyFailure(tk, iss.cpKey, iss.cpLabel, iss.sc, iss.group, iss.ruleKey, iss.ruleId, platSet, iss.page); });

      sec.issues.push({
        id: iss.id, page: iss.page, impact: iss.impact, sc: iss.sc, desc: iss.desc,
        platforms: PLATFORMS.filter(function (p) { return platSet.has(p); }),
        cpLabel: iss.cpLabel, ruleId: iss.ruleId,
        mode: sel.mode || 'none', mappedPageKeys: targets.slice(),
        mappedCount: targets.length, applicableCount: applicableKeys.length
      });
    });
    var pwSections = Array.from(sectionMap.values()).map(function (sec) {
      sec.issues.sort(function (a, b) { return compareSC(a.sc, b.sc) || String(a.id).localeCompare(String(b.id)); });
      sec.issueCount = sec.issues.length;
      sec.unmappedCount = sec.issues.filter(function (i) { return i.mappedCount === 0; }).length;
      sec.applicableCount = sec.applicablePages.length;
      return sec;
    }).sort(function (a, b) { return a.order - b.order || a.label.localeCompare(b.label); });

    // ---- Shape outputs ----
    var pages = Array.from(pagesMap.entries()).map(function (entry) {
      var key = entry[0], p = entry[1];
      return {
        key: key, display: p.display, variants: Array.from(p.variants),
        hasVariantMismatch: p.variants.size > 1, isSiteWide: false, isManual: !!p.isManual,
        presence: PLATFORMS.filter(function (pl) { return p.presence.has(pl); }),
        redistributedFrom: Array.from(p.redistributedFrom),
        platforms: p.platforms, counts: p.counts, coverage: p.platforms.size, totalRows: p.totalRows,
        checkpoints: Array.from(p.checkpoints.values())
          .map(function (cp) { return Object.assign({}, cp, { coverage: cp.platforms.size, sources: Array.from(cp.sources) }); })
          .sort(function (a, b) { return compareSC(a.sc, b.sc) || a.label.localeCompare(b.label); })
      };
    });

    var ruleGroups = Array.from(rulesMap.values())
      .map(function (rg) {
        return { ruleId: rg.ruleId, sc: rg.sc, checkpoint: rg.checkpoint,
          pages: Array.from(rg.pages, function (kv) { return { key: kv[0], display: kv[1].display, platforms: kv[1].platforms }; }) };
      })
      .sort(function (a, b) { return compareSC(a.sc, b.sc) || a.checkpoint.localeCompare(b.checkpoint); });

    return {
      pages: pages, ruleGroups: ruleGroups, sharedUnits: sharedUnits, realPageKeys: realPageKeys,
      pageCatalog: pageCatalog, projectWideKeys: Array.from(pwSet), pwSections: pwSections
    };
  }

  var api = { build: build, compareSC: compareSC, unitKeyFor: unitKeyFor, classifyBucket: classifyBucket, buildPrefixRegex: buildPrefixRegex, buildPlatformLookup: buildPlatformLookup };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RWDModel = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
