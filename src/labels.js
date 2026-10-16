import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { scenario, missileTrailPoints } from './scenario.js';

// Floating HTML tags on the drone, missile and ship, plus the missile's
// trajectory line (solid for the part already flown, dashed for the rest of
// the intercept). Everything is driven by `t` like the rest of the scene and
// can be switched off as a whole.

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

  const drone = tag('drone', 'TARGET DRONE');
  const missile = tag('missile', 'MISSILE');
  const ship = tag('ship', 'FRIGATE 920');
  group.add(drone.obj, missile.obj, ship.obj);

  // Missile trajectory: two geometries sharing one position buffer, each
  // with its own draw range (flown part / remainder).
  const pts = missileTrailPoints(2);
  const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => p.pos));
  const geoAhead = new THREE.BufferGeometry();
  geoAhead.setAttribute('position', geo.attributes.position);
  const flown = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffb02e, transparent: true, opacity: 0.9, depthWrite: false }));
  const ahead = new THREE.Line(geoAhead, new THREE.LineDashedMaterial({
    color: 0xffd27a, dashSize: 6, gapSize: 4, transparent: true, opacity: 0.55, depthWrite: false,
  }));
  ahead.computeLineDistances();
  flown.frustumCulled = ahead.frustumCulled = false;
  flown.renderOrder = ahead.renderOrder = 5;
  group.add(flown, ahead);
  const stepDt = pts.length > 1 ? pts[1].t - pts[0].t : 1;

  let enabled = true;
  const fmt = (v, unit, digits = 0) => `${v.toFixed(digits)}<span>${unit}</span>`;

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
    update(d) {
      if (!enabled) return;
      const { t } = d;
      const { tLaunch, tHit } = scenario;

      // Drone, or its wreckage after the hit (until it sinks).
      const destroyed = t >= tHit;
      drone.obj.visible = !destroyed || d.droneAlt > -2;
      drone.obj.position.copy(d.dronePos).y += destroyed ? 3 : 1.6;
      drone.el.classList.toggle('dead', destroyed);
      drone.title.textContent = destroyed ? 'DRONE · DESTROYED' : 'TARGET DRONE';
      drone.body.innerHTML = destroyed
        ? `ALT ${fmt(Math.max(0, d.droneAlt), ' m')}`
        : `${fmt(d.droneSpeed * 3.6, ' km/h')} · ALT ${fmt(d.droneAlt, ' m')} · ${fmt(d.droneRange, ' m')} <em>to ship</em>`;

      // Missile, only while it flies.
      const flying = t > tLaunch && t < tHit;
      missile.obj.visible = flying;
      if (flying) {
        missile.obj.position.copy(d.missilePos).y += 1.2;
        missile.body.innerHTML = `${fmt(d.missileSpeed * 3.6, ' km/h')} · ${fmt(d.missileRange, ' m')} <em>to target</em>`;
      }

      ship.obj.position.copy(d.shipPos).y += 37;
      ship.body.innerHTML = `${fmt(d.shipSpeed * 1.94384, ' kn')} · ${destroyed ? 'target down' : `${fmt(d.droneRange, ' m')} <em>to drone</em>`}`;

      // Trajectory: hidden before launch, flown part solid, remainder dashed.
      const n = pts.length;
      const i = THREE.MathUtils.clamp(Math.floor((t - tLaunch) / stepDt) + 1, 0, n);
      flown.visible = ahead.visible = t > tLaunch - 1; // preview the shot as the launcher trains
      geo.setDrawRange(0, i);
      const j = Math.max(i - 1, 0);
      geoAhead.setDrawRange(j, n - j);
    },
    render(scene, camera) {
      if (enabled) renderer.render(scene, camera);
    },
  };
}
