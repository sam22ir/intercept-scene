// Master clock plus the playback bar. `t` is the only source of time in the
// scene: playback advances it, the scrubber and keys set it directly.

export function createTimeline(scenario, { onKey } = {}) {
  const $ = (s) => document.querySelector(s);
  const scrub = $('#scrub');
  const playBtn = $('#btn-play');
  const revBtn = $('#btn-reverse');
  const timeNow = $('#time-now');
  const markersEl = $('#markers');

  const clock = {
    t: 0,
    playing: true,
    direction: 1,
    speed: 1,
    tick(dt) {
      if (!this.playing || scrubbing) return;
      this.seek(this.t + dt * this.speed * this.direction);
      if (this.t >= scenario.tEnd || this.t <= 0) this.playing = false;
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
    renderUI() {
      if (!scrubbing) scrub.value = this.t;
      timeNow.textContent = this.t.toFixed(2);
      const fwd = this.playing && this.direction > 0;
      const rev = this.playing && this.direction < 0;
      playBtn.textContent = fwd ? '❚❚' : '▶︎';
      playBtn.classList.toggle('active', fwd);
      revBtn.classList.toggle('active', rev);
      for (const m of markerEls) m.el.classList.toggle('passed', this.t >= m.t);
    },
  };

  scrub.max = scenario.tEnd;
  $('#time-end').textContent = scenario.tEnd.toFixed(1);

  let scrubbing = false;
  scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  window.addEventListener('pointerup', () => { scrubbing = false; });
  scrub.addEventListener('input', () => {
    clock.playing = false;
    clock.seek(parseFloat(scrub.value));
  });

  // Labels closer than ~10% of the bar go on alternating rows.
  let prevFrac = -1;
  let row = 0;
  const markerEls = scenario.events.map(({ t, label }) => {
    const frac = t / scenario.tEnd;
    row = frac - prevFrac < 0.1 ? 1 - row : 0;
    prevFrac = frac;
    const el = document.createElement('div');
    el.className = `marker row-${row}`;
    el.textContent = label;
    el.style.left = `${frac * 100}%`;
    el.title = `${label} — ${t.toFixed(1)} s`;
    el.addEventListener('click', () => clock.seek(t));
    markersEl.appendChild(el);
    return { t, el };
  });

  playBtn.addEventListener('click', () => clock.play(1));
  revBtn.addEventListener('click', () => clock.play(-1));
  $('#btn-step-back').addEventListener('click', () => clock.step(-0.1));
  $('#btn-step-fwd').addEventListener('click', () => clock.step(0.1));
  $('#btn-start').addEventListener('click', () => { clock.playing = false; clock.seek(0); });
  $('#btn-end').addEventListener('click', () => { clock.playing = false; clock.seek(scenario.tEnd); });
  $('#speed').addEventListener('change', (e) => { clock.speed = parseFloat(e.target.value); });

  // Keep focus off buttons so Space never double-fires (key handler + button click).
  document.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => b.blur()));

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement) return;
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
