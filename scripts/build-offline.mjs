// Turns the Vite build into one self-contained HTML file that runs from disk
// (file://) with no internet: the JS bundle and CSS are inlined, and the
// "download offline version" link is dropped from the offline copy.
// Run after `vite build`; writes dist/intercept-offline.html.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
let html = readFileSync(join(dist, 'index.html'), 'utf8');
const read = (href) => readFileSync(join(dist, href.replace(/^\//, '')), 'utf8');

// Replacement callbacks (not strings) so "$&" etc. inside the bundle stay literal.
let scripts = 0;
html = html
  .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, (_, src) => {
    scripts++;
    // A literal "</script" inside the bundle would end the inline tag early.
    const js = read(src).replace(/<\/script/gi, '<\\/script');
    return `<script type="module">\n${js}\n</script>`;
  })
  .replace(/<link rel="stylesheet" crossorigin href="([^"]+)">/g, (_, href) => `<style>\n${read(href)}\n</style>`)
  .replace(/<a id="dl-offline"[\s\S]*?<\/a>/, () => '');

if (scripts !== 1 || /(src|href)="\/assets\//.test(html)) {
  throw new Error('offline build: expected exactly one bundle and no remaining /assets/ references');
}
writeFileSync(join(dist, 'intercept-offline.html'), html);
console.log(`offline build: dist/intercept-offline.html (${(html.length / 1024).toFixed(0)} KB)`);
