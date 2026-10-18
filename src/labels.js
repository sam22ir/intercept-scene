import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { scenario } from './scenario.js';

// Floating HTML tags on the drone, missile and ship. Everything is driven by `t`
// like the rest of the scene and can be switched off as a whole. (The trajectory
// lines live in trails.js, with their own switch.)

function tag(kind, title) {
  const el = document.createElement('div');
  el.className = `tag tag-${kind}`;
  el.innerHTML = `<div class="tag-title">${title}</div><div class="tag-body"></div>`;
  const obj = new CSS2DObject(el);
  el.style.pointerEvents = 'none'; // never steal clicks from the canvas
  obj.center.set(0.5, 1); // anchor at the tag's bottom edge (the leader tick)
  return { obj, el, body: el.querySelector('.tag-body'), title: el.querySelector('.tag-title') };
}

export function createLabels(scene) {
  const renderer = new CSS2DRenderer();
  renderer.domElement.className = 'labels-layer';
  document.body.appendChild(renderer.domElement);

  const group = new THREE.Group();
  group.name = 'labels';
  scene.add(group);

  const pair = scenario.engagements.length > 1; // pair mode: a second drone and missile
  const drone = tag('drone', pair ? 'DRONE 1' : 'TARGET DRONE');
  const missile = tag('missile', 'MISSILE');
  const ship = tag('ship', 'FRIGATE');
  group.add(drone.obj, missile.obj, ship.obj);

  // Second engagement (pair mode only).
  const second = pair ? {
    drone: tag('drone', 'DRONE 2'),
    missile: tag('missile', 'MISSILE 2'),
  } : null;
  if (second) group.add(second.drone.obj, second.missile.obj);

  let enabled = true;
  const fmt = (v, unit, digits = 0) => `${v.toFixed(digits)}<span>${unit}</span>`;
  let knots = false; // speeds in km/h or knots, as the HUD shows them
  const spd = (ms) => (knots ? fmt(ms / 0.514444, ' kn') : fmt(ms * 3.6, ' km/h'));

  return {
    renderer,
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = on;
      group.visible = on;
      renderer.domElement.style.display = on ? '' : 'none';
    },
    resize(w, h) {
      renderer.setSize(w, h);
    },
    // d: { t, dronePos, droneSpeed, droneAlt, missilePos, missileSpeed, missileRange, shipPos, shipSpeed, droneRange }
    setUnits(u) { knots = u === 'kn'; },
    update(d) {
      if (!enabled) return;
      const { t } = d;
      const { tLaunch, tHit } = scenario;

      // Drone, or its wreckage after the hit (until it sinks).
      const destroyed = t >= tHit;
      drone.obj.visible = !destroyed || d.droneAlt > -2;
      drone.obj.position.copy(d.dronePos).y += destroyed ? 3 : 1.6;
      drone.el.classList.toggle('dead', destroyed);
      const recovery = !scenario.hasMissile;
      const underChute = recovery && t >= scenario.tChute;
      const afloat = recovery && t >= scenario.tSplash;
      drone.el.classList.toggle('ok', afloat);
      drone.title.textContent = destroyed ? (pair ? 'DRONE 1 · DESTROYED' : 'DRONE · DESTROYED')
        : afloat ? 'DRONE · RECOVERED'
          : underChute ? 'DRONE · UNDER PARACHUTE' : (pair ? 'DRONE 1' : 'TARGET DRONE');
      drone.body.innerHTML = destroyed
        ? `ALT ${fmt(Math.max(0, d.droneAlt), ' m')}`
        : afloat
          ? `AFLOAT · ${fmt(d.droneRange, ' m')} <em>from ship</em>`
          : `${spd(d.droneSpeed)} · ALT ${fmt(d.droneAlt, ' m')} · ${fmt(d.droneRange, ' m')} <em>to ship</em>`;

      // Missile, only while it flies.
      const flying = t > tLaunch && t < tHit;
      missile.obj.visible = flying;
      if (flying) {
        missile.obj.position.copy(d.missilePos).y += 1.2;
        missile.body.innerHTML = `${spd(d.missileSpeed)} · ${fmt(d.missileRange, ' m')} <em>to target</em>`;
      }

      // Drone 2 and missile 2 (pair mode): same tags, driven by d.second.
      if (second && d.second) {
        const e = scenario.engagements[1];
        const d2 = d.second;
        const dead = t >= e.tHit;
        second.drone.obj.visible = t >= scenario.drones[1].tLoad && (!dead || d2.droneAlt > -2);
        second.drone.obj.position.copy(d2.dronePos).y += dead ? 3 : 1.6;
        second.drone.el.classList.toggle('dead', dead);
        second.drone.title.textContent = dead ? 'DRONE 2 · DESTROYED' : 'DRONE 2';
        second.drone.body.innerHTML = dead
          ? `ALT ${fmt(Math.max(0, d2.droneAlt), ' m')}`
          : `${spd(d2.droneSpeed)} · ALT ${fmt(d2.droneAlt, ' m')} · ${fmt(d2.droneRange, ' m')} <em>to ship</em>`;
        const fly2 = t > e.tLaunch && t < e.tHit;
        second.missile.obj.visible = fly2;
        if (fly2) {
          second.missile.obj.position.copy(d2.missilePos).y += 1.2;
          second.missile.body.innerHTML = `${spd(d2.missileSpeed)} · ${fmt(d2.missileRange, ' m')} <em>to target</em>`;
        }
      }

      ship.obj.position.copy(d.shipPos).y += 37;
      ship.body.innerHTML = `${fmt(d.shipSpeed * 1.94384, ' kn')} · ${destroyed ? 'target down' : `${fmt(d.droneRange, ' m')} <em>to drone</em>`}`;
    },
    render(scene, camera) {
      if (enabled) renderer.render(scene, camera);
    },
  };
}
