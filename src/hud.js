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
  const e = scenario.engagements[k] ?? scenario; // k > 0 is the second drone (pair mode)
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

export function createHud({ onUnits } = {}) {
  const root = document.querySelector('#hud');
  const button = document.querySelector('#btn-hud');
  const unitsButton = document.querySelector('#btn-units');
  const live = root.querySelector('.hud-live');
  const debrief = root.querySelector('.hud-debrief');
  const spark = root.querySelector('.hud-spark');
  const chute = !scenario.hasMissile;
  const engs = scenario.engagements;
  const nDrones = scenario.drones.length;
  const pair = nDrones > 1;
  const infos = scenario.drones.map((_, k) => computeDebrief(k));
  const info = infos[0];
  const tEndOf = (k) => (chute ? scenario.tSplash : engs[k].tHit);
  const tAllDone = chute ? scenario.tSplash : engs[engs.length - 1].tHit;

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
  const tile = (label, value, unit, cls = '') => `<div class="tile ${cls}"><span>${label}</span><b>${value}${unit ? `<small>${unit}</small>` : ''}</b></div>`;
  const head = (title, chip, tone) => `<div class="hud-head"><b>${title}</b><span class="chip ${tone}">${chip}</span></div>`;
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

  // The story so far and what comes next, from the timeline's own events.
  function phaseHtml(t) {
    const ev = scenario.events;
    let cur = ev[0];
    let next = null;
    for (const e of ev) { if (e.t <= t) cur = e; else { next = e; break; } }
    const nextTxt = next ? `<em>${next.label} in ${secs(next.t - t)}<small>${secsUnit(next.t - t)}</small></em>` : '';
    return `<div class="hud-phase"><b>${cur.label}</b>${nextTxt}</div>`;
  }

  // Full readouts of drone k (the one the HUD follows).
  function droneHtml(t, k) {
    const [state, tone] = droneState(t, k);
    const title = pair ? `Drone ${k + 1}` : 'Drone';
    let tiles;
    if (t < tEndOf(k)) {
      const r = rangeAt(t, k);
      const closing = closingAt(t, k);
      const onRail = t < scenario.drones[k].tRelease;
      // An inbound drone inside the launch range is the threat: amber, red inside half of it.
      const threat = !chute && closing > 0 && !onRail && r < scenario.launchRange
        ? (r < scenario.launchRange / 2 ? 'threat-high' : 'threat') : '';
      tiles = tile('Range to ship', f(r), 'm', threat) + tile('Bearing', fmtBearing(droneBearing(t, k)), '', 'brg')
        + tile('Altitude', f(Math.max(0, planePos(t, _p, k).y)), 'm')
        + tile('Speed', onRail ? '—' : spd(droneSpeed(t, k)), onRail ? '' : spdUnit())
        + (onRail ? '' : tile(closing >= 0 ? 'Closing' : 'Opening', spd(closing), spdUnit(), 'opt'));
    } else {
      tiles = tile('Status', chute ? 'Afloat' : 'Down', '', 'wide');
    }
    return `<div class="hud-sec">${head(title, state, tone)}<div class="tiles">${tiles}</div></div>`;
  }

  function missileHtml(t, k) {
    const e = engs[k];
    const inf = infos[k];
    const mTitle = pair ? `Missile ${k + 1}` : 'Missile';
    if (t > e.tLaunch && t < e.tHit) {
      const a = Math.max(t - 0.02, e.tLaunch);
      const b = Math.min(t + 0.02, e.tHit);
      const v = missilePos(b, _p, k).distanceTo(missilePos(a, _q, k)) / (b - a);
      const rng = missilePos(t, _p, k).distanceTo(planePos(t, _q, k));
      const p = (t - e.tLaunch) / (e.tHit - e.tLaunch);
      return head(mTitle, 'In flight', 'warn')
        + `<div class="tiles"><div class="tile"><span>Impact in</span><b class="big-count">${f(e.tHit - t, 1)}<small>s</small></b></div>`
        + `${tile('Speed', spd(v), spdUnit())}${tile('To target', f(rng), 'm', 'opt')}</div>`
        + `<div class="bar" style="--p:${p.toFixed(3)}"><i></i></div>`;
    }
    if (t <= e.tLaunch) {
      // Long before the shot there is nothing to watch but the countdown; close to it, the big count.
      const soon = e.tLaunch - t < 15;
      return head(mTitle, soon ? 'Ready' : 'Standby', soon ? 'warn' : '')
        + `<div class="tiles">${soon ? `<div class="tile"><span>Launch in</span><b class="big-count">${f(e.tLaunch - t, 1)}<small>s</small></b></div>`
          : tile('Launch in', secs(e.tLaunch - t), secsUnit(e.tLaunch - t))}${tile('Fires at', f(inf.launchRange), 'm')}</div>`;
    }
    // After the hit: what the shot did, until the debrief takes over.
    return head(mTitle, 'Hit', 'bad')
      + `<div class="tiles">${tile('Intercept at', f(inf.interceptRange), 'm')}${tile('Flight time', f(inf.missileFlight, 1), 's')}`
      + `${tile('Peak speed', spd(inf.missileVmax), spdUnit(), 'opt')}</div>`;
  }

  function recoveryHtml(t) {
    if (t < scenario.tChute) {
      return head('Recovery', 'Standby', '')
        + `<div class="tiles">${tile('Chute in', secs(scenario.tChute - t), secsUnit(scenario.tChute - t))}${tile('Opens at', f(info.chuteAlt), 'm')}</div>`;
    }
    if (t < scenario.tSplash) {
      const rate = f((planePos(t - H, _p).y - planePos(t + H, _q).y) / (2 * H), 1);
      return head('Recovery', 'Descending', 'warn')
        + `<div class="tiles">${tile('Descent', rate, 'm/s')}${tile('Splashdown in', f(scenario.tSplash - t, 1), 's')}</div>`;
    }
    return head('Recovery', 'Done', 'ok') + `<div class="tiles">${tile('Splashdown', f(info.splashRange), 'm', 'wide')}</div>`;
  }

  // Pair mission: the drone the HUD is not following, on one line.
  function otherHtml(t, k) {
    const [state, tone] = droneState(t, k);
    const e = engs[k];
    let txt;
    if (t < scenario.drones[k].tRelease) txt = `Launch in ${secs(scenario.drones[k].tRelease - t)}${secsUnit(scenario.drones[k].tRelease - t) && ' s'}`;
    else if (t < e.tHit) {
      txt = `${f(rangeAt(t, k))} m · ${fmtBearing(droneBearing(t, k))} · ${f(Math.max(0, planePos(t, _p, k).y))} m up`;
      if (t > e.tLaunch) txt += ` · impact ${f(e.tHit - t, 1)} s`;
    } else txt = `Hit ${f(infos[k].interceptRange)} m out`;
    return `<div class="hud-other"><b>Drone ${k + 1}</b><span class="chip ${tone}">${state}</span><em>${txt}</em></div>`;
  }

  // Pair mission: follow the drone (or missile) the camera is on, else the one still flying.
  function followed(t, focus) {
    if (!pair) return 0;
    if (focus === 'plane2' || focus === 'missile2') return 1;
    if (focus === 'plane' || focus === 'missile') return 0;
    return t >= engs[0].tHit ? 1 : 0;
  }

  function liveHtml(t, focus) {
    const k = followed(t, focus);
    const second = chute ? recoveryHtml(t) : missileHtml(t, k);
    const other = pair ? otherHtml(t, 1 - k) : '';
    return `${phaseHtml(t)}${droneHtml(t, k)}<div class="hud-sec">${second}</div>${other}`;
  }

  function debriefHtml() {
    const cols = infos.length;
    const row = (label, fn) => `<span>${label}</span>${infos.map((inf, k) => `<b>${fn(inf, k)}</b>`).join('')}`;
    const headline = chute ? '<div class="deb-head ok">Drone recovered</div>'
      : `<div class="deb-head bad">${pair ? 'Both targets destroyed' : 'Target destroyed'}</div>`;
    const rows = [];
    if (pair) rows.push(`<span></span>${infos.map((_, k) => `<em class="sub">Drone ${k + 1}</em>`).join('')}`);
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
    return `<div class="hud-head"><b>Debrief</b><span class="chip ${chute ? 'ok' : 'bad'}">Complete</span></div>${headline}`
      + `<div class="deb-rows" style="--cols:${cols}">${rows.join('')}</div>`;
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
    const html = done ? '' : liveHtml(t, focus);
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
