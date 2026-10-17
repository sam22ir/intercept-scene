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

function rangeAt(t) {
  planePos(t, _p);
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
function computeDebrief() {
  const chute = !scenario.hasMissile;
  const tEndRun = chute ? scenario.tSplash : scenario.tHit;
  const d = {
    droneFlight: tEndRun - scenario.tRelease,
    droneG: peakG(planePos, 0, tEndRun, 0.25, 0.05),
  };
  if (!chute) {
    d.miss = scenario.interceptMiss;
    d.missileFlight = scenario.tHit - scenario.tLaunch;
    // Skip the last 0.15 s: the final sample is snapped onto the drone, which is not real acceleration.
    d.missileG = peakG(missilePos, scenario.tLaunch, scenario.tHit - 0.15, 0.05, 0.025);
  }
  return d;
}

export function createHud() {
  const root = document.querySelector('#hud');
  const button = document.querySelector('#btn-hud');
  const live = root.querySelector('.hud-live');
  const debrief = root.querySelector('.hud-debrief');
  const telemetry = document.querySelector('.telemetry'); // the older, smaller readout: shown only when the HUD is off
  const chute = !scenario.hasMissile;
  const info = computeDebrief();

  let enabled = true;
  try { enabled = localStorage.getItem(KEY) !== '0'; } catch { /* storage unavailable */ }

  const f = (v, d = 0) => v.toFixed(d);
  const cell = (label, value) => `<div><span>${label}</span><b>${value}</b></div>`;
  let lastHtml = '';
  let lastDeb = null;

  function liveHtml(t) {
    const rows = [];
    const endT = chute ? scenario.tSplash : scenario.tHit;
    if (t < endT) {
      const r = rangeAt(t);
      const a = Math.max(t - H, 0);
      const closing = -(rangeAt(t + H) - rangeAt(a)) / (t + H - a);
      rows.push(cell('Range to ship', `${f(r)} m`), cell('Altitude', `${f(planePos(t, _p).y)} m`),
        cell('Closing speed', `${closing < 0 ? '-' : ''}${f(Math.abs(closing))} m/s`));
    } else {
      rows.push(cell('Drone', chute ? 'landed' : 'destroyed'));
    }
    if (chute) {
      let rate = '—';
      if (t >= scenario.tChute && t < scenario.tSplash) {
        rate = `${f((planePos(t - H, _p).y - planePos(t + H, _q).y) / (2 * H), 1)} m/s`;
      }
      rows.push(cell('Descent rate', rate));
    } else {
      const flying = t > scenario.tLaunch && t < scenario.tHit;
      rows.push(cell('Missile impact in', flying ? `${f(scenario.tHit - t, 1)} s` : '—'));
      let spd = '—';
      if (flying) {
        const a = Math.max(t - 0.02, scenario.tLaunch);
        const b = Math.min(t + 0.02, scenario.tHit);
        spd = `${f(missilePos(b, _p).distanceTo(missilePos(a, _q)) / (b - a))} m/s`;
      }
      rows.push(cell('Missile speed', spd));
    }
    return rows.join('');
  }

  function debriefHtml() {
    const rows = ['<div class="hud-h">Debrief</div>'];
    if (!chute) rows.push(cell('Miss before snap', `${f(info.miss, 1)} m`));
    rows.push(cell('Drone flight', `${f(info.droneFlight, 1)} s`));
    if (!chute) rows.push(cell('Missile flight', `${f(info.missileFlight, 1)} s`), cell('Max missile G', f(info.missileG)));
    rows.push(cell('Max drone G', f(info.droneG, 1)));
    return rows.join('');
  }

  function paint() {
    root.hidden = !enabled;
    if (telemetry) telemetry.hidden = enabled;
    button.classList.toggle('active', enabled);
    button.setAttribute('aria-pressed', String(enabled));
  }

  function setEnabled(on) {
    enabled = on;
    paint();
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
    lastHtml = ''; lastDeb = null; // repaint on the next update
  }

  function update(t) {
    if (!enabled) return;
    const html = liveHtml(t);
    if (html !== lastHtml) { live.innerHTML = html; lastHtml = html; }
    const show = t >= (chute ? scenario.tSplash : scenario.tHit);
    if (show !== lastDeb) {
      lastDeb = show;
      debrief.hidden = !show;
      if (show) debrief.innerHTML = debriefHtml();
    }
  }

  // Phones: the HUD flows inside the timeline panel (above its controls) so it can never
  // cover the scrub bar. Elsewhere it is a fixed panel. (A fixed child of the timeline
  // would be positioned against its transform/backdrop-filter, hence the reparenting.)
  const phone = globalThis.matchMedia?.('(max-width: 640px), (max-height: 560px)');
  const place = () => {
    const tl = document.querySelector('.timeline');
    if (phone?.matches) tl.insertBefore(root, tl.firstChild);
    else document.body.appendChild(root);
  };
  place();
  phone?.addEventListener?.('change', place);

  paint();
  button.addEventListener('click', () => setEnabled(!enabled));

  return { update, toggle: () => setEnabled(!enabled), get enabled() { return enabled; }, info };
}
