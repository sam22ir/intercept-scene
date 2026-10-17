// Live readouts and the end-of-run debrief. Every number is a pure function of the
// sim time t, taken from scenario.js (positions at t +- a small dt, never frame deltas),
// so scrubbing in either direction always shows the right values.
import * as THREE from 'three';
import {
  scenario, planePos, missilePos, shipPos, G,
} from './scenario.js';

const SHIP_CENTER_Y = 10; // same reference point the range markers in scenario.js use
const H = 0.05; // finite-difference half-step, seconds
const KEY = 'intercept.hud';

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _s = new THREE.Vector3();

function rangeAt(t, k = 0) {
  planePos(t, _p, k);
  shipPos(t, _s);
  _s.y += SHIP_CENTER_Y;
  return _p.distanceTo(_s);
}

// Peak |a| / g of a sampled path using a central second difference.
function peakG(fn, t0, t1, h, step) {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  let best = 0;
  for (let t = t0 + h; t <= t1 - h; t += step) {
    fn(t - h, a); fn(t, b); fn(t + h, c);
    d.copy(c).sub(b).sub(b.clone().sub(a));
    best = Math.max(best, d.length() / (h * h));
  }
  return best / G;
}

// Computed once: the story is fixed after import.
function computeDebrief(k = 0) {
  const chute = !scenario.hasMissile;
  const e = scenario.engagements[k] ?? scenario; // k > 0 is the second drone (pair mode)
  const tRelease = scenario.drones[k].tRelease;
  const tEndRun = chute ? scenario.tSplash : e.tHit;
  const d = {
    droneFlight: tEndRun - tRelease,
    droneG: peakG((t, out) => planePos(t, out, k), tRelease - scenario.tRelease, tEndRun, 0.25, 0.05),
  };
  if (!chute) {
    d.miss = e.interceptMiss;
    d.burst = e.burstDist;
    d.missileFlight = e.tHit - e.tLaunch;
    // Skip the last 0.15 s: the final sample is snapped onto the drone, which is not real acceleration.
    d.missileG = peakG((t, out) => missilePos(t, out, k), e.tLaunch, e.tHit - 0.15, 0.05, 0.025);
  }
  return d;
}

export function createHud() {
  const root = document.querySelector('#hud');
  const button = document.querySelector('#btn-hud');
  const live = root.querySelector('.hud-live');
  const debrief = root.querySelector('.hud-debrief');
  const chute = !scenario.hasMissile;
  const info = computeDebrief();
  // Pair mission: a second debrief block, and the live readouts follow whichever drone is current.
  const engs = scenario.engagements;
  const pair = engs.length > 1;
  const infos = pair ? engs.map((_, k) => (k ? computeDebrief(k) : info)) : null;
  const tAllDone = chute ? scenario.tSplash : engs[engs.length - 1].tHit;

  let enabled = true;
  try { enabled = localStorage.getItem(KEY) !== '0'; } catch { /* storage unavailable */ }

  const f = (v, d = 0) => v.toFixed(d);
  const kmh = (ms) => f(Math.abs(ms) * 3.6);
  const tile = (label, value, unit, cls = '') => `<div class="tile ${cls}"><span>${label}</span><b>${value}${unit ? `<small>${unit}</small>` : ''}</b></div>`;
  const head = (title, chip, tone) => `<div class="hud-head"><b>${title}</b><span class="chip ${tone}">${chip}</span></div>`;
  let lastHtml = '';
  let lastDeb = null;

  // Ground speed of drone k at t, from positions at t +- H (never frame deltas).
  function droneSpeed(t, k) {
    const a = Math.max(t - H, 0);
    return planePos(t + H, _p, k).distanceTo(planePos(a, _q, k)) / (t + H - a);
  }

  function droneState(t, k) {
    const d = scenario.drones[k];
    if (t < d.tSpool) return ['On the rail', ''];
    if (t < d.tRelease) return ['Launching', 'live'];
    if (chute) {
      if (t < scenario.tChute) return ['Airborne', 'live'];
      if (t < scenario.tSplash) return ['Under canopy', 'warn'];
      return ['Recovered', 'ok'];
    }
    return t < engs[k].tHit ? ['Airborne', 'live'] : ['Destroyed', 'bad'];
  }

  function liveHtml(t) {
    const k = pair && t >= engs[0].tHit ? 1 : 0; // the drone still flying
    const e = engs[k];
    const endT = chute ? scenario.tSplash : e.tHit;
    const [state, tone] = droneState(t, k);
    const title = pair ? `Drone ${k + 1}` : 'Drone';
    let drone;
    if (t < endT) {
      const r = rangeAt(t, k);
      const a = Math.max(t - H, 0);
      const closing = -(rangeAt(t + H, k) - rangeAt(a, k)) / (t + H - a);
      drone = tile('Range to ship', f(r), 'm') + tile('Altitude', f(Math.max(0, planePos(t, _p, k).y)), 'm')
        + tile('Speed', kmh(droneSpeed(t, k)), 'km/h')
        + tile(closing >= 0 ? 'Closing' : 'Opening', kmh(closing), 'km/h', 'opt');
    } else {
      drone = tile('Status', chute ? 'Afloat' : 'Down', '', 'wide');
    }
    let second;
    if (chute) {
      const falling = t >= scenario.tChute && t < scenario.tSplash;
      const rate = falling ? f((planePos(t - H, _p).y - planePos(t + H, _q).y) / (2 * H), 1) : '—';
      const toGo = falling ? `${f(scenario.tSplash - t, 1)}<small>s</small>` : '—';
      second = head('Recovery', falling ? 'Descending' : t < scenario.tChute ? 'Standby' : 'Done', falling ? 'warn' : '')
        + `<div class="tiles">${tile('Descent', rate, falling ? 'm/s' : '')}${tile('Splashdown in', toGo, '')}</div>`;
    } else {
      const flying = t > e.tLaunch && t < e.tHit;
      const mTitle = pair ? `Missile ${k + 1}` : 'Missile';
      if (flying) {
        const a = Math.max(t - 0.02, e.tLaunch);
        const b = Math.min(t + 0.02, e.tHit);
        const spd = missilePos(b, _p, k).distanceTo(missilePos(a, _q, k)) / (b - a);
        const rng = missilePos(t, _p, k).distanceTo(planePos(t, _q, k));
        const p = (t - e.tLaunch) / (e.tHit - e.tLaunch);
        second = head(mTitle, 'In flight', 'warn')
          + `<div class="tiles"><div class="tile"><span>Impact in</span><b class="big-count">${f(e.tHit - t, 1)}<small>s</small></b></div>`
          + `${tile('Speed', kmh(spd), 'km/h')}${tile('To target', f(rng), 'm', 'opt')}</div>`
          + `<div class="bar" style="--p:${p.toFixed(3)}"><i></i></div>`;
      } else if (t <= e.tLaunch) {
        second = head(mTitle, 'Ready', '')
          + `<div class="tiles">${tile('Launch in', f(e.tLaunch - t, 1), 's')}${tile('Speed', '—', '', 'opt')}</div>`;
      } else {
        second = head(mTitle, 'Hit', 'bad') + `<div class="tiles">${tile('Flight time', f(e.tHit - e.tLaunch, 1), 's', 'wide')}</div>`;
      }
    }
    return `<div class="hud-sec">${head(title, state, tone)}<div class="tiles">${drone}</div></div><div class="hud-sec">${second}</div>`;
  }

  function debriefHtml() {
    const row = (label, value) => `<div><span>${label}</span><b>${value}</b></div>`;
    const headline = chute ? '<div class="deb-head ok">Drone recovered</div>'
      : `<div class="deb-head bad">${pair ? 'Both targets destroyed' : 'Target destroyed'}</div>`;
    const rows = [];
    (infos ?? [info]).forEach((inf, k) => {
      if (infos) rows.push(`<div class="sub">Drone ${k + 1}</div>`);
      rows.push(row('Drone flight', `${f(inf.droneFlight, 1)} s`), row('Max drone G', f(inf.droneG, 1)));
      if (!chute) {
        rows.push(row('Missile flight', `${f(inf.missileFlight, 1)} s`), row('Max missile G', f(inf.missileG)),
          row('Warhead', inf.burst < 2.6 ? 'Direct hit' : `Burst ${f(inf.burst)} m away`));
        if (inf.miss > 0) rows.push(row('Missile fell short', `${f(inf.miss, 1)} m`));
      }
    });
    return `<div class="hud-head"><b>Debrief</b><span class="chip ${chute ? 'ok' : 'bad'}">Complete</span></div>${headline}<div class="deb-rows">${rows.join('')}</div>`;
  }

  function paint() {
    root.hidden = !enabled;
    button.classList.toggle('active', enabled);
    button.setAttribute('aria-pressed', String(enabled));
  }

  function setEnabled(on) {
    enabled = on;
    paint();
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
    lastHtml = ''; lastDeb = null; // repaint on the next update
  }

  // Before the end: live readouts. At the end: the debrief replaces them.
  function update(t) {
    if (!enabled) return;
    const done = t >= tAllDone;
    const html = done ? '' : liveHtml(t);
    if (html !== lastHtml) { live.innerHTML = html; lastHtml = html; }
    if (done !== lastDeb) {
      lastDeb = done;
      debrief.hidden = !done;
      if (done) debrief.innerHTML = debriefHtml();
    }
  }

  paint();
  button.addEventListener('click', () => setEnabled(!enabled));

  return { update, toggle: () => setEnabled(!enabled), get enabled() { return enabled; }, info };
}
