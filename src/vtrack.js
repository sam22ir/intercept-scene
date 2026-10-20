// The drill layout's two moving parts, shared by the scenes that wear it (body.mission-maneuvers):
//
// - createVTrack: the timeline stood on end down the left side (wide windows): the same line with its chapters,
//   laid out vertically, time running downward. Names are pushed apart so they never overlap, each joined to its
//   tick by a short leader. Drag the line or click a name to move through time. (The CSS hides the horizontal bar
//   in the playback panel then, so there is one timeline, not two.) It is a pure function of t: update(t) only
//   reads the clock.
// - createCamStrip: the camera buttons move from the playback panel to a strip at the top on desktop windows
//   (the CSS places it: top centre from 1100 px, beside the readout card below that); phones keep them in the panel.
//
// The CSS is the `.vtrack` / `.vt-*` and `.camstrip` blocks in style.css.

// events: [{ t, label }]; tEnd: s; clock: the timeline clock (playing, seek); fmt(t) for the tooltips.
export function createVTrack({ events, tEnd, clock, invalidate = () => {}, fmt = (t) => `${t.toFixed(1)} s` }) {
  const root = document.createElement('div');
  root.id = 'vtrack';
  root.className = 'vtrack';
  root.innerHTML = '<div class="vt-rail"><i class="vt-fill"></i><i class="vt-thumb"></i></div><svg class="vt-lead" aria-hidden="true"></svg><div class="vt-labels"></div>';
  document.body.appendChild(root);
  const rail = root.querySelector('.vt-rail');
  const lead = root.querySelector('.vt-lead');
  const labels = root.querySelector('.vt-labels');
  const items = events.map((e) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'vt-label';
    el.textContent = e.label;
    el.title = `${e.label} · ${fmt(e.t)}`;
    el.addEventListener('click', () => { clock.playing = false; clock.seek(e.t); invalidate(); });
    labels.appendChild(el);
    return { t: e.t, el };
  });

  let done = -2;
  function layout() {
    const h = root.clientHeight;
    if (h < 40) return;
    const GAP = 19;
    const ys = items.map((e) => (Math.min(Math.max(e.t / tEnd, 0), 1)) * (h - 12) + 6);
    const ly = ys.slice();
    for (let i = 1; i < ly.length; i++) ly[i] = Math.max(ly[i], ly[i - 1] + GAP); // push down
    const over = ly[ly.length - 1] - (h - 8);
    if (over > 0) for (let i = ly.length - 1; i >= 0; i--) { ly[i] -= over; if (i < ly.length - 1) ly[i] = Math.min(ly[i], ly[i + 1] - GAP); } // pull back up
    let d = '';
    items.forEach((e, i) => {
      e.el.style.top = `${ly[i] - 9}px`;
      d += `<path d="M13 ${ys[i].toFixed(1)} H20 L28 ${ly[i].toFixed(1)}"/><circle cx="13" cy="${ys[i].toFixed(1)}" r="2.6"/>`;
    });
    lead.innerHTML = d;
    done = -2;
  }

  function seekFrom(e) {
    const r = rail.getBoundingClientRect();
    clock.playing = false;
    clock.seek(Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1) * tEnd);
    invalidate();
  }
  let drag = false;
  rail.addEventListener('pointerdown', (e) => { drag = true; rail.setPointerCapture?.(e.pointerId); seekFrom(e); });
  rail.addEventListener('pointermove', (e) => { if (drag) seekFrom(e); });
  rail.addEventListener('pointerup', () => { drag = false; });
  rail.addEventListener('pointercancel', () => { drag = false; });

  function update(t) {
    root.style.setProperty('--p', Math.min(Math.max(t / tEnd, 0), 1).toFixed(4));
    let cur = -1;
    items.forEach((e, i) => { if (t >= e.t) cur = i; });
    if (cur !== done) {
      done = cur;
      items.forEach((e, i) => { e.el.classList.toggle('passed', i <= cur); e.el.classList.toggle('current', i === cur); });
    }
  }

  // Laid out on the next frame, never inside the observer's callback: moving the names there would make the
  // browser report a "ResizeObserver loop", which start.js would show as a fatal error.
  let queued = false;
  const queue = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; layout(); }); };
  if (typeof ResizeObserver === 'function') new ResizeObserver(queue).observe(root);
  window.addEventListener('resize', queue);
  layout();
  return { el: root, update, layout };
}

export function createCamStrip({ invalidate = () => {}, query = '(min-width: 901px)' } = {}) {
  const seg = document.querySelector('.seg.cam');
  const home = seg.parentElement;
  const strip = document.createElement('div');
  strip.id = 'camstrip';
  strip.className = 'camstrip';
  document.body.appendChild(strip);
  const wide = window.matchMedia(query);
  const place = () => { if (wide.matches) strip.appendChild(seg); else home.prepend(seg); invalidate(); };
  place();
  wide.addEventListener?.('change', place);
  return { el: strip };
}
