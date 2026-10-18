// Master clock plus the playback bar. `t` is the only source of time in the
// scene: playback advances it, the scrubber and keys set it directly.

export function createTimeline(scenario, { onKey } = {}) {
  const $ = (s) => document.querySelector(s);
  const scrub = $('#scrub');
  const playBtn = $('#btn-play');
  const revBtn = $('#btn-reverse');
  const timeNow = $('#time-now');
  const markersEl = $('#markers');
  const ticksEl = $('#ticks');
  const phaseNow = $('#phase-now');
  const phaseNext = $('#phase-next');
  const speedBtn = $('#speed');
  const prevBtn = $('#btn-start');
  const nextBtn = $('#btn-end');
  const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16];

  const clock = {
    t: 0,
    playing: true,
    direction: 1,
    speed: 1,
    tick(dt) {
      if (!this.playing || scrubbing) return;
      // `slow(t)` may cap the speed for a stretch (the maneuvers mission slows down at each order).
      const speed = this.slow ? Math.min(this.speed, this.slow(this.t)) : this.speed;
      this.seek(this.t + dt * speed * this.direction);
      if ((this.direction > 0 && this.t >= scenario.tEnd) || (this.direction < 0 && this.t <= 0)) this.playing = false;
    },
    seek(t) {
      this.t = Math.min(Math.max(t, 0), scenario.tEnd);
    },
    play(direction) {
      if (this.playing && this.direction === direction) {
        this.playing = false;
        return;
      }
      if (direction > 0 && this.t >= scenario.tEnd) this.t = 0;
      if (direction < 0 && this.t <= 0) this.t = scenario.tEnd;
      this.direction = direction;
      this.playing = true;
    },
    step(dt) {
      this.playing = false;
      this.seek(this.t + dt);
    },
    // Jump to the previous / next event on the bar (the first and last jump to 0 and the end).
    prevEvent() {
      const hit = [...scenario.events].reverse().find((e) => e.t < this.t - 0.15);
      this.playing = false;
      this.seek(hit ? hit.t : 0);
    },
    nextEvent() {
      const hit = scenario.events.find((e) => e.t > this.t + 0.05);
      this.playing = false;
      this.seek(hit ? hit.t : scenario.tEnd);
    },
    setSpeed(v) {
      this.speed = v;
      speedBtn.textContent = `${v}×`;
    },
    // Step through the speeds, clamped at both ends.
    faster() { this.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(this.speed) + 1)] ?? 1); },
    slower() { this.setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(this.speed) - 1)] ?? 1); },
    renderUI() {
      if (!scrubbing) scrub.value = this.t;
      scrub.style.setProperty('--p', (this.t / scenario.tEnd).toFixed(4));
      timeNow.textContent = this.t.toFixed(1);
      const fwd = this.playing && this.direction > 0;
      const rev = this.playing && this.direction < 0;
      playBtn.classList.toggle('active', fwd);
      playBtn.setAttribute('aria-label', fwd ? 'Pause' : 'Play');
      revBtn.classList.toggle('active', rev);
      // The current phase is the last event at or before t; the next one gets a countdown.
      let cur = -1;
      for (let i = 0; i < markerEls.length; i++) {
        const passed = this.t >= markerEls[i].t;
        markerEls[i].el.classList.toggle('passed', passed);
        markerEls[i].tick.classList.toggle('passed', passed);
        if (passed) cur = i;
      }
      const now = markerEls[cur]?.label ?? '';
      const next = markerEls[cur + 1];
      const nextText = next ? ` · ${next.label} in ${(next.t - this.t).toFixed(1)} s` : '';
      if (phaseNow.textContent !== now) phaseNow.textContent = now;
      if (phaseNext.textContent !== nextText) phaseNext.textContent = nextText;
      // The skip buttons say where they would go.
      const nextTitle = next && cur + 1 < markerEls.length ? `Next event: ${next.label} (.)` : 'Jump to the end (.)';
      if (nextBtn.title !== nextTitle) nextBtn.title = nextTitle;
      const before = markerEls.filter((m) => m.t < this.t - 0.15).at(-1);
      const prevTitle = before ? `Previous event: ${before.label} (,)` : 'Back to the start (,)';
      if (prevBtn.title !== prevTitle) prevBtn.title = prevTitle;
    },
  };

  scrub.max = scenario.tEnd;
  $('#time-end').textContent = scenario.tEnd.toFixed(1);

  let scrubbing = false;
  scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  // pointercancel too: the browser cancels the pointer when a touch turns into a gesture.
  window.addEventListener('pointerup', () => { scrubbing = false; });
  window.addEventListener('pointercancel', () => { scrubbing = false; });
  scrub.addEventListener('input', () => {
    clock.playing = false;
    clock.seek(parseFloat(scrub.value));
  });

  // One tick per event on the bar; labels above it are laid out in pixels (see layoutMarkers).
  const markerEls = scenario.events.map(({ t, label }) => {
    const frac = t / scenario.tEnd;
    const el = document.createElement('div');
    el.className = 'marker';
    el.textContent = label;
    el.title = `${label} — ${t.toFixed(1)} s`;
    el.addEventListener('click', () => { clock.playing = false; clock.seek(t); });
    markersEl.appendChild(el);
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.title = el.title;
    tick.style.left = `${frac * 100}%`;
    ticksEl.appendChild(tick);
    return { t, frac, label, el, tick };
  });

  // Greedy placement: each label goes on the first of MAX_ROWS rows where it clears its
  // neighbour by GAP px, clamped inside the bar; a label that fits nowhere is hidden
  // (its tick stays, with the name as its tooltip). Re-run on every resize.
  const ROW_H = 16;
  const GAP = 8;
  const MAX_ROWS = 4;
  function layoutMarkers() {
    const w = markersEl.clientWidth;
    if (!w) return; // hidden (phone layouts show ticks only)
    const ends = new Array(MAX_ROWS).fill(-Infinity);
    let rows = 0;
    for (const m of markerEls) {
      m.el.hidden = false;
      const lw = m.el.offsetWidth;
      const x = m.frac * w;
      const left = Math.min(Math.max(x - lw / 2, 0), w - lw);
      const r = ends.findIndex((end) => left >= end + GAP);
      if (r < 0) { m.el.hidden = true; m.tick.classList.remove('stem'); continue; }
      ends[r] = left + lw;
      rows = Math.max(rows, r + 1);
      m.el.style.left = `${left}px`;
      m.el.style.top = `${r * ROW_H}px`;
      m.row = r;
    }
    markersEl.parentElement.style.setProperty('--label-rows', `${rows * ROW_H + 2}px`);
    // Each labelled tick grows up to the bottom of its label's row (measured with no stems).
    for (const m of markerEls) m.tick.classList.remove('stem');
    const tick0 = markerEls[0].tick;
    const tickTop = ticksEl.getBoundingClientRect().top + tick0.offsetTop;
    const rowsTop = markersEl.getBoundingClientRect().top;
    for (const m of markerEls) {
      if (m.el.hidden) continue;
      m.tick.classList.add('stem');
      m.tick.style.setProperty('--stem', `${Math.max(0, tickTop - (rowsTop + (m.row + 1) * ROW_H))}px`);
    }
  }
  layoutMarkers();
  // Re-layout on width changes only, a frame later: layoutMarkers changes the track's own
  // height, and doing that inside the observer callback is a ResizeObserver loop error.
  let lastW = markersEl.clientWidth;
  let pending = 0;
  const relayout = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      if (markersEl.clientWidth === lastW) return;
      lastW = markersEl.clientWidth;
      layoutMarkers();
    });
  };
  if (globalThis.ResizeObserver) new ResizeObserver(relayout).observe(markersEl.parentElement);
  window.addEventListener('resize', relayout);

  playBtn.addEventListener('click', () => clock.play(1));
  revBtn.addEventListener('click', () => clock.play(-1));
  $('#btn-step-back').addEventListener('click', () => clock.step(-0.1));
  $('#btn-step-fwd').addEventListener('click', () => clock.step(0.1));
  prevBtn.addEventListener('click', () => clock.prevEvent());
  nextBtn.addEventListener('click', () => clock.nextEvent());
  // One button: click for the next speed (wrapping back to the slowest), right-click for the previous.
  speedBtn.addEventListener('click', () => { if (clock.speed >= SPEEDS[SPEEDS.length - 1]) clock.setSpeed(SPEEDS[0]); else clock.faster(); });
  speedBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); clock.slower(); });

  // Keep focus off buttons so Space never double-fires (key handler + button click).
  document.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => b.blur()));

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement) return;
    // Typing in a number or text field is never a shortcut.
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    // Ctrl/Cmd chords (undo, reload, copy) go to the editor or the browser, never to playback.
    if (e.ctrlKey || e.metaKey) { onKey?.(e.key, e); return; }
    const big = e.shiftKey ? 1 : 0.1;
    switch (e.key) {
      case ' ': clock.play(1); break;
      case 'r': case 'R': clock.play(-1); break;
      case 'ArrowLeft': clock.step(-big); break;
      case 'ArrowRight': clock.step(big); break;
      case 'Home': clock.playing = false; clock.seek(0); break;
      case 'End': clock.playing = false; clock.seek(scenario.tEnd); break;
      default: onKey?.(e.key, e); return;
    }
    e.preventDefault();
  });

  return clock;
}
