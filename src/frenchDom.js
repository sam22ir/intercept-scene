// The missions in French. The missions write their interface in English; when the interface language is
// French (i18n.js), start.js installs this before it loads a mission's scene, and it translates every text
// the page shows (text nodes, title, aria-label and placeholder attributes, the tab title) as it appears,
// from the dictionary in missionFr.js. A MutationObserver sees each change, so readouts that rewrite
// themselves every frame stay French; its callback runs before the page paints, so the English never shows.
// The harbour pilot speaks French already and does not use it. Text drawn on a canvas (the maps, the path
// editor's tags) is not text the page can see, so it stays as the mission draws it.
//
// The dictionary: exact strings, and patterns in which {} stands for a part that varies (a number, a name);
// a varying part is itself looked up, so "Next: Impact in 2.0 s" becomes "Suivant : Impact dans 2.0 s"
// with "Impact" translated too. In a French text, {} takes the parts in order, {0} {1} … by position.

const ATTRS = ['title', 'aria-label', 'placeholder'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);
const escapeRe = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

export function compile(dict) {
  const exact = new Map();
  const patterns = [];
  for (const [en, fr] of Object.entries(dict)) {
    const key = en.replace(/\s+/g, ' ').trim();
    if (!key.includes('{}')) { exact.set(key, fr); continue; }
    const parts = key.split('{}');
    const re = new RegExp(`^${parts.map(escapeRe).join('(.+?)')}$`, 's');
    // The longest fixed part screens the text before the regular expression runs.
    const probe = parts.reduce((a, b) => (b.length > a.length ? b : a), '');
    patterns.push({ re, fr, probe, weight: key.length - (parts.length - 1) * 2 });
  }
  patterns.sort((a, b) => b.weight - a.weight); // the most specific first
  return { exact, patterns };
}

export function translator(dict) {
  const { exact, patterns } = compile(dict);
  const cache = new Map();
  const part = (s) => {
    const t = s.trim();
    if (!t) return s;
    const hit = exact.get(t);
    return hit === undefined ? s : s.replace(t, hit);
  };
  function tr(text) {
    const norm = text.replace(/\s+/g, ' ').trim();
    if (!norm || !/[A-Za-z]/.test(norm)) return null;
    if (cache.has(norm)) return cache.get(norm);
    let out = exact.get(norm) ?? null;
    if (out === null) {
      for (const p of patterns) {
        if (p.probe && !norm.includes(p.probe)) continue;
        const m = p.re.exec(norm);
        if (!m) continue;
        // A pattern with little fixed text ("{} and {}") only takes short parts (names, numbers), so it
        // never half-translates a sentence the dictionary does not know.
        if (p.weight < 10 && m.slice(1).some((v) => v.length > 24)) continue;
        const vals = m.slice(1).map(part);
        let k = 0;
        out = p.fr.replace(/\{(\d*)\}/g, (_, i) => (i === '' ? vals[k++] : vals[Number(i)]) ?? '');
        break;
      }
    }
    if (cache.size > 4000) cache.clear();
    cache.set(norm, out);
    return out;
  }
  // Keep the text node's own leading and trailing spaces round the translation.
  tr.node = (text) => {
    const out = tr(text);
    if (out === null) return null;
    const lead = text.match(/^\s*/)[0];
    const trail = text.match(/\s*$/)[0];
    return lead + out + trail;
  };
  return tr;
}

export function installFrench(dict, root = document.body, { skip = '#chooser' } = {}) {
  const tr = translator(dict);
  const done = new WeakMap(); // text node -> the French we wrote (so our own write is not translated again)
  const written = new Set(); // every French text written, for scan()
  const wrote = (s) => { if (written.size < 20000) written.add(s.replace(/\s+/g, ' ').trim()); };
  const skipped = (el) => !el || SKIP.has(el.nodeName) || (skip && el.closest?.(skip)) || el.closest?.('[data-no-fr]');
  const text = (n) => {
    if (done.get(n) === n.data) return;
    if (skipped(n.parentElement)) return;
    const out = tr.node(n.data);
    if (out !== null && out !== n.data) { n.data = out; done.set(n, out); wrote(out); }
  };
  const attrs = (el) => {
    for (const a of ATTRS) {
      const v = el.getAttribute?.(a);
      if (!v) continue;
      const out = tr(v);
      if (out !== null && out !== v) { el.setAttribute(a, out); wrote(out); }
    }
  };
  const walk = (node) => {
    if (node.nodeType === 3) { text(node); return; }
    if (node.nodeType !== 1 || skipped(node)) return;
    attrs(node);
    const it = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      if (n.nodeType === 3) text(n); else attrs(n);
    }
  };
  walk(root);
  const title = () => { const out = tr(document.title); if (out !== null && out !== document.title) document.title = out; };
  title();
  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') text(m.target);
      else if (m.type === 'attributes') { if (!skipped(m.target)) attrs(m.target); }
      else for (const n of m.addedNodes) walk(n);
    }
  });
  obs.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  const head = document.querySelector('title');
  if (head) new MutationObserver(title).observe(head, { childList: true, characterData: true, subtree: true });
  document.documentElement.lang = 'fr';
  // For checking the dictionary: the texts and tooltips on the page that are still in English.
  const scan = () => {
    const left = new Set();
    const look = (v) => { const t = v.replace(/\s+/g, ' ').trim(); if (/[a-z]{3}/i.test(t) && !written.has(t) && tr(t) === null) left.add(t); };
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = it.nextNode(); n; n = it.nextNode()) {
      if (n.nodeType === 3) { if (!skipped(n.parentElement)) look(n.data); } else if (!skipped(n)) for (const a of ATTRS) { const v = n.getAttribute(a); if (v) look(v); }
    }
    return [...left];
  };
  return { tr, scan, stop: () => obs.disconnect() };
}
