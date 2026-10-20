// Live readouts and the end-of-run debrief. Every number is a pure function of the
// sim time t, taken from scenario.js (positions at t +- a small dt, never frame deltas),
// so scrubbing in either direction always shows the right values.
import * as THREE from 'three';
import {
  scenario, planePos, planeRelPos, missilePos, shipPos, G,
} from './scenario.js';

const SHIP_CENTER_Y = 10; // same reference point the range markers in scenario.js use
const H = 0.05; // finite-difference half-step, seconds
const KEY = 'intercept.hud';
const UNITS_KEY = 'intercept.units'; // 'kmh' or 'kn'
const KT = 0.514444; // m/s per knot
const SPARK_DT = 0.25; // s between sparkline samples
const SPARK_W = 200;
const SPARK_H = 36;

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _s = new THREE.Vector3();

function rangeAt(t, k = 0) {
  planePos(t, _p, k);
  shipPos(t, _s);
  _s.y += SHIP_CENTER_Y;
  return _p.distanceTo(_s);
}

// Relative bearing of a point in the ship frame (x ahead, z to starboard): degrees clockwise from the bow.
const relBearing = (x, z) => ((THREE.MathUtils.radToDeg(Math.atan2(z, x)) % 360) + 360) % 360;
// Naval style: Green to starboard, Red to port, 0 to 180 from the bow.
function fmtBearing(deg) {
  const side = deg <= 180 ? 'Green' : 'Red';
  const a = Math.round(deg <= 180 ? deg : 360 - deg);
  if (a === 0) return 'Ahead';
  if (a === 180) return 'Astern';
  return `${side} ${String(a).padStart(3, '0')}`;
}
const droneBearing = (t, k) => { planeRelPos(t, _p, k); return relBearing(_p.x, _p.z); };

// Peak load factor (the G felt on board: |a - gravity| / g) of a sampled path, using a central
// second difference. Level flight reads 1, a 47 degree banked turn about 1.5.
function peakG(fn, t0, t1, h, step) {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  let best = 0;
  for (let t = t0 + h; t <= t1 - h; t += step) {
    fn(t - h, a); fn(t, b); fn(t + h, c);
    d.copy(c).sub(b).sub(b.clone().sub(a));
    d.y += G * h * h; // hold off gravity: sitting still reads 1 G
    best = Math.max(best, d.length() / (h * h));
  }
  return best / G;
}

// Computed once: the story is fixed after import.
function computeDebrief(k = 0) {
  const chute = !scenario.hasMissile;
  const e = scenario.engagements[k] ?? scenario;
  const dr = scenario.drones[k];
  const tEndRun = chute ? scenario.tSplash : e.tHit;
  // From just after the booster: the catapult stroke is not the airframe manoeuvring.
  const tFly = dr.tBoost1 + 0.5;
  let closest = Infinity;
  for (let t = tFly; t < (chute ? scenario.tChute : e.tHit); t += 0.1) closest = Math.min(closest, rangeAt(t, k));
  const d = {
    droneFlight: tEndRun - dr.tRelease,
    droneG: peakG((t, out) => planePos(t, out, k), tFly, chute ? scenario.tChute : tEndRun, 0.25, 0.05),
    closest,
  };
  if (chute) {
    d.chuteAlt = planePos(scenario.tChute, _p, k).y;
    d.descent = scenario.tSplash - scenario.tChute;
    planePos(scenario.tSplash, _p, k).sub(shipPos(scenario.tSplash, _s)); // the ship moves by pure translation
    d.splashRange = Math.hypot(_p.x, _p.z);
    d.splashBearing = relBearing(_p.x, _p.z);
  } else {
    d.miss = e.interceptMiss;
    d.burst = e.burstDist;
    d.missileFlight = e.tHit - e.tLaunch;
    d.launchRange = rangeAt(e.tLaunch, k);
    shipPos(e.tHit, _s); _s.y += SHIP_CENTER_Y;
    d.interceptRange = e.hitPos.distanceTo(_s);
    // Skip the last 0.15 s: the final sample is snapped onto the drone, which is not real acceleration.
    d.missileG = peakG((t, out) => missilePos(t, out, k), e.tLaunch, e.tHit - 0.15, 0.05, 0.025);
    let vmax = 0;
    for (let t = e.tLaunch + 0.02; t < e.tHit - 0.15; t += 0.02) {
      vmax = Math.max(vmax, missilePos(t + 0.02, _p, k).distanceTo(missilePos(t - 0.02, _q, k)) / 0.04);
    }
    d.missileVmax = vmax;
  }
  return d;
}

export function createHud({ onUnits, missionSub = '' } = {}) {
  const root = document.querySelector('#hud');
  const button = document.querySelector('#btn-hud');
  const unitsButton = document.querySelector('#btn-units');
  const live = root.querySelector('.hud-live');
  const debrief = root.querySelector('.hud-debrief');
  const spark = root.querySelector('.hud-spark');
  const chute = !scenario.hasMissile;
  const engs = scenario.engagements;
  const infos = scenario.drones.map((_, k) => computeDebrief(k));
  const info = infos[0];
  const tEndOf = (k) => (chute ? scenario.tSplash : engs[k].tHit);
  const tAllDone = chute ? scenario.tSplash : engs[engs.length - 1].tHit;
  const missionLine = missionSub;

  let enabled = true;
  let units = 'kmh';
  try {
    enabled = localStorage.getItem(KEY) !== '0';
    if (localStorage.getItem(UNITS_KEY) === 'kn') units = 'kn';
  } catch { /* storage unavailable */ }

  const f = (v, d = 0) => v.toFixed(d);
  const spd = (ms) => (units === 'kn' ? f(Math.abs(ms) / KT) : f(Math.abs(ms) * 3.6));
  const spdUnit = () => (units === 'kn' ? 'kn' : 'km/h');
  const secs = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : f(s, 1));
  const secsUnit = (s) => (s >= 60 ? '' : 's'); // m:ss carries no unit
  // A row of the readout card: label, value, and a small note (the drill's `.mh-cell`, `cls` colours its dot).
  const cell = (cls, label, value, note = '', title = '') => `<div class="mh-cell ${cls}"${title ? ` title="${title}"` : ''}><span>${label}</span><b>${value}</b><em>${note}</em></div>`;
  const u = (v, unit) => `${v}<i>${unit}</i>`;
  let lastHtml = '';
  let lastDeb = null;
  let lastCursor = '';

  // Ground speed of drone k at t, from positions at t +- H (never frame deltas).
  function droneSpeed(t, k) {
    const a = Math.max(t - H, 0);
    return planePos(t + H, _p, k).distanceTo(planePos(a, _q, k)) / (t + H - a);
  }
  const closingAt = (t, k) => {
    const a = Math.max(t - H, 0);
    return -(rangeAt(t + H, k) - rangeAt(a, k)) / (t + H - a);
  };

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

  // The chapter card: the story so far (the timeline's own events), the drone's state, how far through this
  // chapter, and what comes next.
  function chapterHtml(t) {
    const ev = scenario.events;
    let cur = ev[0];
    let next = null;
    for (const e of ev) { if (e.t <= t) cur = e; else { next = e; break; } }
    const [state, tone] = droneState(t, 0);
    const p = next ? Math.min(Math.max((t - cur.t) / (next.t - cur.t), 0), 1) : 1;
    const nextTxt = next ? `Next: ${next.label} in ${secs(next.t - t)}${secsUnit(next.t - t) && ' s'}` : '';
    return '<div class="mcard mcard-order"><div class="mh-bar"><div class="mh-title">'
      + `<b>${cur.label}</b><div class="mh-sub"><small>${missionLine}</small><span class="chip shown ${tone}">${state}</span></div></div>`
      + '<div class="mh-btns"><button type="button" data-hide title="Hide these cards (H, or the Readouts button)" aria-label="Hide">×</button></div></div>'
      + `<div class="mh-progress" title="How far through this chapter"><i style="width:${(p * 100).toFixed(1)}%"></i></div>`
      + `<div class="mh-next"${nextTxt ? '' : ' hidden'}>${nextTxt}</div></div>`;
  }

  // The drone's rows: range (amber, then red, while an inbound drone is inside the launch range), bearing and height, speed.
  function droneRows(t) {
    if (t >= tEndOf(0)) return cell('drone', 'Drone', chute ? 'Afloat' : 'Down', chute ? `${f(info.splashRange)} m out` : '');
    const r = rangeAt(t, 0);
    const closing = closingAt(t, 0);
    const onRail = t < scenario.drones[0].tRelease;
    const threat = !chute && closing > 0 && !onRail && r < scenario.launchRange
      ? (r < scenario.launchRange / 2 ? ' threat-high' : ' threat') : '';
    return cell(`drone${threat}`, 'Range', u(f(r), 'm'), onRail ? 'on the rail' : `${closing >= 0 ? 'closing' : 'opening'} ${spd(closing)} ${spdUnit()}`, 'Range from the drone to the ship')
      + cell('drone', 'Bearing', fmtBearing(droneBearing(t, 0)), `${f(Math.max(0, planePos(t, _p, 0).y))} m up`, 'Relative bearing from the bow, and the altitude of the drone')
      + cell('drone', 'Speed', onRail ? '—' : u(spd(droneSpeed(t, 0)), spdUnit()), '');
  }

  function missileRows(t) {
    const e = engs[0];
    if (t > e.tLaunch && t < e.tHit) {
      const a = Math.max(t - 0.02, e.tLaunch);
      const b = Math.min(t + 0.02, e.tHit);
      const v = missilePos(b, _p, 0).distanceTo(missilePos(a, _q, 0)) / (b - a);
      const rng = missilePos(t, _p, 0).distanceTo(planePos(t, _q, 0));
      return cell('missile live', 'Missile', u(f(e.tHit - t, 1), 's'), 'to impact')
        + cell('missile', 'To target', u(f(rng), 'm'), `${spd(v)} ${spdUnit()}`);
    }
    if (t <= e.tLaunch) {
      const soon = e.tLaunch - t < 15;
      return cell(`missile${soon ? ' warn' : ''}`, soon ? 'Missile ready' : 'Missile', u(secs(e.tLaunch - t), secsUnit(e.tLaunch - t)), `fires at ${f(info.launchRange)} m`, 'Time to launch, and the range it fires at');
    }
    return cell('missile hit', 'Missile', 'Hit', `${f(info.interceptRange)} m out`);
  }

  function recoveryRows(t) {
    if (t < scenario.tChute) return cell('missile', 'Parachute', u(secs(scenario.tChute - t), secsUnit(scenario.tChute - t)), `opens at ${f(info.chuteAlt)} m`);
    if (t < scenario.tSplash) {
      const rate = f((planePos(t - H, _p).y - planePos(t + H, _q).y) / (2 * H), 1);
      return cell('missile warn', 'Descent', u(rate, 'm/s'), `splash in ${f(scenario.tSplash - t, 1)} s`);
    }
    return cell('missile ok', 'Recovery', 'Done', `${f(info.splashRange)} m out`);
  }

  function liveHtml(t) {
    return `${chapterHtml(t)}<div class="mcard mcard-ships mh-ships"><div class="mh-row">${droneRows(t)}${chute ? recoveryRows(t) : missileRows(t)}</div></div>`;
  }

  function debriefHtml() {
    const cols = infos.length;
    const row = (label, fn) => `<span>${label}</span>${infos.map((inf, k) => `<b>${fn(inf, k)}</b>`).join('')}`;
    const headline = chute ? '<div class="deb-head ok">Drone recovered</div>'
      : `<div class="deb-head bad">Target destroyed</div>`;
    const rows = [];
    rows.push(row('Drone flight', (i) => `${f(i.droneFlight, 1)} s`), row('Max drone G', (i) => f(i.droneG, 1)),
      row('Closest to ship', (i) => `${f(i.closest)} m`));
    if (chute) {
      rows.push(row('Chute opened at', (i) => `${f(i.chuteAlt)} m`), row('Descent', (i) => `${f(i.descent, 1)} s`),
        row('Splashdown', (i) => `${f(i.splashRange)} m`), row('Bearing', (i) => fmtBearing(i.splashBearing)));
    } else {
      rows.push(row('Launch range', (i) => `${f(i.launchRange)} m`), row('Intercept range', (i) => `${f(i.interceptRange)} m`),
        row('Missile flight', (i) => `${f(i.missileFlight, 1)} s`), row('Max missile G', (i) => f(i.missileG)),
        row('Peak speed', (i) => `${spd(i.missileVmax)} ${spdUnit()}`),
        row('Warhead', (i) => (i.burst < 2.6 ? 'Direct hit' : `Burst ${f(i.burst)} m`)));
      if (infos.some((i) => i.miss > 0)) rows.push(row('Fell short', (i) => (i.miss > 0 ? `${f(i.miss, 1)} m` : '—')));
    }
    return `<div class="mcard mcard-deb"><div class="hud-head"><b>Debrief</b><span class="chip ${chute ? 'ok' : 'bad'}">Complete</span></div>${headline}`
      + `<div class="deb-rows" style="--cols:${cols}">${rows.join('')}</div></div>`;
  }

  // Range to the ship over the whole run, one line per drone, with a cursor at t. Baked once.
  const sparkEnd = tAllDone + 1;
  const xOf = (t) => (Math.min(Math.max(t / sparkEnd, 0), 1) * SPARK_W).toFixed(1);
  let cursor = null;
  if (spark) {
    let rMax = scenario.launchRange;
    const series = scenario.drones.map((dr, k) => {
      const pts = [];
      for (let t = 0; t <= Math.min(tEndOf(k), sparkEnd); t += SPARK_DT) {
        const r = rangeAt(t, k);
        rMax = Math.max(rMax, r);
        pts.push([t, r]);
      }
      return pts;
    });
    rMax *= 1.08;
    const yOf = (r) => (SPARK_H - (r / rMax) * SPARK_H).toFixed(1);
    const lines = series.map((pts, k) => `<polyline class="d${k}" points="${pts.map(([t, r]) => `${xOf(t)},${yOf(r)}`).join(' ')}"/>`).join('');
    const lr = chute ? '' : `<line class="lr" x1="0" x2="${SPARK_W}" y1="${yOf(scenario.launchRange)}" y2="${yOf(scenario.launchRange)}"/>`;
    const hits = chute ? '' : engs.map((e) => `<line class="hit" x1="${xOf(e.tHit)}" x2="${xOf(e.tHit)}" y1="0" y2="${SPARK_H}"/>`).join('');
    const maxTxt = rMax >= 1000 ? `${f(rMax / 1000, 1)} km` : `${f(rMax)} m`;
    spark.classList.add('mcard');
    spark.innerHTML = `<div class="spark-cap"><span>Range to ship</span><small>${maxTxt}</small></div>`
      + `<svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">${lr}${hits}${lines}`
      + '<line class="cur" x1="0" x2="0" y1="0" y2="36"/></svg>'
      + (chute ? '' : `<div class="spark-cap"><small>dashed: launch range ${f(scenario.launchRange)} m</small></div>`);
    cursor = spark.querySelector('.cur');
  }

  function paint() {
    root.hidden = !enabled;
    button.classList.toggle('active', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    if (unitsButton) {
      unitsButton.setAttribute('aria-pressed', String(units === 'kn'));
      unitsButton.firstChild.textContent = units === 'kn' ? 'Speeds in km/h' : 'Speeds in knots';
      unitsButton.title = `Show speeds in ${units === 'kn' ? 'km/h' : 'knots'} (U)`;
    }
  }

  function setEnabled(on) {
    enabled = on;
    paint();
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
    lastHtml = ''; lastDeb = null; // repaint on the next update
  }

  function setUnits(u) {
    units = u === 'kn' ? 'kn' : 'kmh';
    paint();
    try { localStorage.setItem(UNITS_KEY, units); } catch { /* storage unavailable */ }
    lastHtml = ''; lastDeb = null;
    onUnits?.(units);
  }

  // Before the end: live readouts. At the end: the debrief replaces them.
  function update(t, focus) {
    if (!enabled) return;
    const done = t >= tAllDone;
    const html = done ? '' : liveHtml(t);
    if (html !== lastHtml) { live.innerHTML = html; lastHtml = html; }
    if (done !== lastDeb) {
      lastDeb = done;
      debrief.hidden = !done;
      if (done) debrief.innerHTML = debriefHtml();
    }
    if (cursor) {
      const x = xOf(t);
      if (x !== lastCursor) { cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); lastCursor = x; }
    }
  }

  paint();
  onUnits?.(units);
  button.addEventListener('click', () => setEnabled(!enabled));
  root.addEventListener('click', (e) => { if (e.target.closest('[data-hide]')) setEnabled(false); });
  unitsButton?.addEventListener('click', () => setUnits(units === 'kn' ? 'kmh' : 'kn'));

  return {
    update,
    toggle: () => setEnabled(!enabled),
    toggleUnits: () => setUnits(units === 'kn' ? 'kmh' : 'kn'),
    get enabled() { return enabled; },
    get units() { return units; },
    info,
  };
}
