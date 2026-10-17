// Shareable deep links. Nothing here runs while the scene plays: the URL is only
// built (and never written to the address bar) when the viewer asks for it.

const b64url = (str) => btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// state: { ship, mode, t, focus, director, path }  ->  absolute URL string
export function buildShareUrl({ ship, mode, t, focus, director, path }, base = globalThis.location?.href ?? '') {
  const u = new URL(base);
  u.search = '';
  u.hash = '';
  u.searchParams.set('ship', ship);
  u.searchParams.set('mode', mode);
  u.searchParams.set('t', String(Math.round(t * 100) / 100));
  if (director) u.searchParams.set('cam', 'director');
  else if (focus && focus !== 'free') u.searchParams.set('focus', focus);
  if (path) {
    const points = path.map((p) => p.map((v) => Math.round(v * 10) / 10));
    u.hash = `path=${b64url(JSON.stringify({ points }))}`;
  }
  return u.toString();
}

// Reads ?t= and ?focus= (and ?cam=director) from the page URL.
export function readShareParams(search = globalThis.location?.search ?? '') {
  try {
    const q = new URLSearchParams(search);
    const t = q.has('t') ? parseFloat(q.get('t')) : NaN;
    return { t: Number.isFinite(t) ? t : null, focus: q.get('focus'), director: q.get('cam') === 'director' };
  } catch {
    return { t: null, focus: null, director: false };
  }
}

// Removes the view-specific parts (t, focus, cam, #path) from the address bar.
export function stripShareParams() {
  try {
    const u = new URL(location.href);
    for (const k of ['t', 'focus', 'cam']) u.searchParams.delete(k);
    u.hash = '';
    history.replaceState(null, '', u);
  } catch { /* replaceState is not allowed under file:// or in sandboxed frames */ }
}

// Button + fallback box. getState() returns the state for buildShareUrl.
export function createShare({ button, getState, toast, onChange }) {
  let box = null;
  function showBox(url) {
    if (!box) {
      box = document.createElement('div');
      box.className = 'share-box';
      box.innerHTML = '<label>Copy this link <input type="text" readonly></label><button type="button">Close</button>';
      box.addEventListener('keydown', (e) => e.stopPropagation());
      box.querySelector('button').addEventListener('click', () => { box.hidden = true; onChange?.(); });
      document.body.appendChild(box);
    }
    box.hidden = false;
    const input = box.querySelector('input');
    input.value = url;
    input.focus();
    input.select();
    onChange?.();
  }
  button.addEventListener('click', async () => {
    let url;
    try { url = buildShareUrl(getState()); } catch { toast('Could not build a link here.'); return; }
    try {
      await navigator.clipboard.writeText(url);
      toast(getState().path ? 'Link copied (includes your custom path).' : 'Link copied.');
    } catch {
      showBox(url);
    }
  });
  return { buildUrl: () => buildShareUrl(getState()) };
}
