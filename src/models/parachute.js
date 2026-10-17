import * as THREE from 'three';
import { canvasTexture } from './kit.js';
import { scenario } from '../scenario.js';

// Orange recovery parachute (recovery mission only). Everything is a function
// of t: a pilot chute pops out of the drone's back, the lines pay out, the
// canopy streams and then inflates, the drone hangs below it, and after
// splashdown the canopy collapses onto the water beside the drone.

const R = 2.9; // canopy radius
const GORES = 24;
const LINES = 16;
const CAP = Math.PI * 0.43; // dome angle from the apex down to the skirt
const LINE_LENGTH = 5.0;

// Harness points on top of the fuselage, drone frame (nose +Z).
const HARNESS_FRONT = new THREE.Vector3(0, 0.4, 0.34);
const HARNESS_REAR = new THREE.Vector3(0, 0.3, -0.62);

function canopyTexture() {
  // u runs around the canopy (24 gores), v from the skirt (0, bottom) to the apex (1, top).
  return canvasTexture(1024, 256, (ctx, W, H) => {
    for (let g = 0; g < GORES; g++) {
      ctx.fillStyle = g % 2 ? '#ff6a0d' : '#ff7b1f';
      ctx.fillRect((g / GORES) * W, 0, W / GORES + 1, H);
    }
    // Seams.
    ctx.strokeStyle = 'rgba(110, 40, 0, 0.55)';
    ctx.lineWidth = 2;
    for (let g = 0; g < GORES; g++) {
      ctx.beginPath();
      ctx.moveTo((g / GORES) * W, 0);
      ctx.lineTo((g / GORES) * W, H);
      ctx.stroke();
    }
    // Reinforcement tapes and hem band.
    ctx.fillStyle = 'rgba(255, 235, 200, 0.55)';
    ctx.fillRect(0, H * 0.78, W, 6);
    ctx.fillStyle = '#ff5a05';
    ctx.fillRect(0, H * 0.94, W, H * 0.06);
    // Apex vent.
    const v = ctx.createLinearGradient(0, 0, 0, H * 0.1);
    v.addColorStop(0, '#2a1204');
    v.addColorStop(1, 'rgba(42, 18, 4, 0)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H * 0.1);
  });
}

export function createParachute() {
  const group = new THREE.Group();
  group.name = 'parachute';
  group.visible = false;

  const material = new THREE.MeshStandardMaterial({
    map: canopyTexture(), roughness: 0.78, metalness: 0, side: THREE.DoubleSide,
    emissive: 0x3a1200, emissiveIntensity: 0.6,
  });
  const dome = new THREE.SphereGeometry(R, 48, 20, 0, Math.PI * 2, 0, CAP);
  dome.translate(0, -R * Math.cos(CAP), 0); // skirt plane at y = 0
  // The canopy has its own transform (position, tilt, squash); the pilot chute
  // and the lines live in world space directly under `group`.
  const canopyGroup = new THREE.Group();
  canopyGroup.add(new THREE.Mesh(dome, material));
  group.add(canopyGroup);

  // Pilot chute and its line.
  const pilot = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 8, 0, Math.PI * 2, 0, CAP), material);
  pilot.visible = false;
  pilot.scale.set(1, 0.8, 1);
  group.add(pilot);

  // Suspension lines (rim -> harness) plus the pilot-chute line.
  const linePos = new Float32Array((LINES + 1) * 2 * 3);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xeee6d6, transparent: true, opacity: 0.9 }));
  lines.frustumCulled = false;
  group.add(lines);

  const up = new THREE.Vector3(0, 1, 0);
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const droneUp = new THREE.Vector3();
  const stream = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const rim = new THREE.Vector3();
  const pilotPos = new THREE.Vector3();
  const collapsed = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const sm = THREE.MathUtils.smoothstep;
  const lerp = THREE.MathUtils.lerp;

  return {
    group,
    // pos / quat: the drone's world pose this frame.
    update(t, pos, quat) {
      const tau = t - scenario.tChute;
      if (tau < 0) { group.visible = false; return; }
      group.visible = true;

      A.copy(HARNESS_FRONT).applyQuaternion(quat).add(pos);
      B.copy(HARNESS_REAR).applyQuaternion(quat).add(pos);
      mid.addVectors(A, B).multiplyScalar(0.5);
      fwd.set(0, 0, 1).applyQuaternion(quat);
      droneUp.set(0, 1, 0).applyQuaternion(quat);

      // Opening: lines pay out, canopy streams back and up, then inflates.
      const payout = sm(tau, 0.05, 0.55);
      const inflate = sm(tau, 0.4, 1.8);
      stream.copy(fwd).multiplyScalar(-0.85).addScaledVector(up, 0.5).normalize();
      dir.copy(stream).lerp(droneUp.multiplyScalar(0.5).addScaledVector(up, 0.5).normalize(), inflate).normalize();
      const breath = inflate * Math.sin(tau * 9);
      let sxz = 0.1 + 0.9 * inflate + 0.025 * breath;
      let sy = (1 + 1.3 * (1 - inflate)) * (0.86 + 0.03 * Math.sin(tau * 9 + 1) * inflate);
      origin.copy(mid).addScaledVector(dir, LINE_LENGTH * payout);

      // After splashdown the canopy settles onto the water downwind of the drone.
      const ta = t - scenario.tSplash;
      if (ta > 0) {
        const k = sm(ta, 0, 2.6);
        collapsed.set(mid.x + 3.4, 0.16, mid.z + 1.8);
        origin.lerp(collapsed, k);
        dir.lerp(up, k).normalize();
        sxz = lerp(sxz, 1.3, k);
        sy = lerp(sy, 0.05, k);
      }

      canopyGroup.position.copy(origin);
      canopyGroup.quaternion.copy(q.setFromUnitVectors(up, dir));
      canopyGroup.scale.set(sxz, sy, sxz);
      canopyGroup.updateMatrix();

      // Lines from the skirt to the two harness points (world space).
      const rimR = R * Math.sin(CAP);
      for (let k = 0; k < LINES; k++) {
        const a = (k / LINES) * Math.PI * 2;
        rim.set(Math.cos(a) * rimR, 0, Math.sin(a) * rimR).applyMatrix4(canopyGroup.matrix);
        const end = Math.cos(a) > 0 ? A : B; // front half to the front point, rear half to the rear
        linePos.set([rim.x, rim.y, rim.z, end.x, end.y, end.z], k * 6);
      }

      // Pilot chute: out on its own line during the first 0.6 s.
      const pilotOn = tau < 0.6;
      pilot.visible = pilotOn;
      pilotPos.copy(mid).addScaledVector(fwd, -2.6 * sm(tau, 0, 0.3)).addScaledVector(up, 1.3 * sm(tau, 0, 0.3));
      pilot.position.copy(pilotPos);
      const base = LINES * 6;
      if (pilotOn) linePos.set([B.x, B.y, B.z, pilotPos.x, pilotPos.y, pilotPos.z], base);
      else linePos.fill(0, base, base + 6);
      lineGeo.attributes.position.needsUpdate = true;
    },
  };
}
