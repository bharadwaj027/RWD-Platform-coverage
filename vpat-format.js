// VPAT remark assembly — the single source of truth for how a VPAT sentence is built
// from the Conformance Calculator data. Kept DOM-free and framework-free so it can be
// loaded both by the browser tool (script.js) and by the Node regression test, meaning
// the test exercises the exact same code the tool runs.
//
// Hard rule: the descriptive sentence comes VERBATIM from bulleted_vpat_text.json
// (VPAT Text One / VPAT Text Multiple). The tool never rewrites, paraphrases, or
// re-pluralizes it. All the tool does is insert the applicable page names — each with
// its {platform} annotation — at the page-reference location, exactly the way the
// Conformance Calculator does.
;(function (root) {
  'use strict';

  function vpatLabel(platform, vpatLabels) {
    return (vpatLabels && vpatLabels[platform]) || platform;
  }

  function pageHasPlatform(pg, p) {
    return pg.platforms instanceof Set ? pg.platforms.has(p) : (pg.platforms || []).indexOf(p) >= 0;
  }

  // "Page Name {Desktop, Responsive Web Design Tablet}" for one affected page.
  function vpatPageLine(pg, platforms, vpatLabels) {
    var plats = platforms
      .filter(function (p) { return pageHasPlatform(pg, p); })
      .map(function (p) { return vpatLabel(p, vpatLabels); });
    return pg.display + ' {' + plats.join(', ') + '}';
  }

  // The affected-pages clause: pages separated by "; ", terminated with ".".
  function vpatPageList(pages, platforms, vpatLabels) {
    return pages.map(function (pg) { return vpatPageLine(pg, platforms, vpatLabels); }).join('; ') + '.';
  }

  // Build the full paste-ready VPAT remark.
  //   m = { one, multiple, hasProse, pages:[{display, platforms}] }
  // Selection follows the Conformance Calculator: one applicable page -> VPAT Text One,
  // multiple pages -> VPAT Text Multiple. The page-reference clause ("This occurs on the
  // following page:" / "pages:") is added exactly as the Calculator adds it, because the
  // source sentences themselves end at the period and do not carry it. If a source
  // sentence already contains a "following page(s):" clause, the pages are appended
  // straight after it (no duplicate clause). With no prose, only the page list is emitted
  // (the tool never invents wording).
  function vpatRemark(m, platforms, vpatLabels) {
    var pageList = vpatPageList(m.pages, platforms, vpatLabels);
    if (!m.hasProse) return pageList;
    var prose = (m.pages.length === 1 ? m.one : m.multiple) || m.one || m.multiple;
    if (!prose) return pageList;
    prose = prose.replace(/\s+$/, ''); // strip only trailing whitespace before the clause
    if (/following page/i.test(prose)) return prose + ' ' + pageList;
    var clause = ' This occurs on the following ' + (m.pages.length === 1 ? 'page' : 'pages') + ': ';
    return prose + clause + pageList;
  }

  var api = {
    vpatLabel: vpatLabel,
    vpatPageLine: vpatPageLine,
    vpatPageList: vpatPageList,
    vpatRemark: vpatRemark
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VPATFormat = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
