import * as THREE from 'three';
import { canvasTexture } from './kit.js';
import { scenario } from '../scenario.js';

// Red square recovery parachute (recovery mission only). Everything is a function
// of t: a pilot chute pops out of the drone's back, the lines pay out, the
// canopy streams and then inflates, the drone hangs below it, and after
// splashdown the canopy collapses onto the water beside the drone.
//
// The canopy is a square sheet, arched like a ram-air wing: it bows up across
// the span (x) and a little along the chord (z), its four corners drooping to the
// skirt plane at y = 0. Its local +Z points along the drone's heading.

const HALF = 2.7; // half the side of the square (5.4 m canopy)
const ARCH_SPAN = 1.15; // rise across x, at the middle of the chord
const ARCH_CHORD = 0.5; // extra rise along z
const LINES = 16; // suspension lines, spaced evenly around the square's edge
const CAP = Math.PI * 0.43; // pilot chute dome angle
const LINE_LENGTH = 5.0;
const RED = 0xd3141c;

// Height of the sheet above the skirt plane at (x, z), both within ±HALF.
const archY = (x, z) => ARCH_SPAN * (1 - (x / HALF) ** 2) + ARCH_CHORD * (1 - (z / HALF) ** 2) * (1 - (x / HALF) ** 2);

// A point on the square's edge, k = 0..LINES-1 going once around, with its sheet height.
function edgePoint(k, out) {
  const p = (k / LINES) * 4;
  const side = Math.floor(p);
  const f = p - side;
  const c = [[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF]];
  const [ax, az] = c[side];
  const [bx, bz] = c[(side + 1) % 4];
  const x = ax + (bx - ax) * f;
  const z = az + (bz - az) * f;
  return out.set(x, archY(x, z), z);
}

// Harness points on top of the fuselage, drone frame (nose +Z).
const HARNESS_FRONT = new THREE.Vector3(0, 0.4, 0.34);
const HARNESS_REAR = new THREE.Vector3(0, 0.3, -0.62);

function canopyTexture() {
  // u runs across the span (x), v along the chord (z): red cells with seams, a white
  // centre stripe and a darker hem.
  return canvasTexture(1024, 1024, (ctx, W, H) => {
    const CELLS = 9;
    for (let c = 0; c < CELLS; c++) {
      ctx.fillStyle = c % 2 ? '#c8121a' : '#dd1e26';
      ctx.fillRect((c / CELLS) * W, 0, W / CELLS + 1, H);
    }
    ctx.strokeStyle = 'rgba(70, 0, 4, 0.6)';
    ctx.lineWidth = 3;
    for (let c = 0; c <= CELLS; c++) {
      ctx.beginPath();
      ctx.moveTo((c / CELLS) * W, 0);
      ctx.lineTo((c / CELLS) * W, H);
      ctx.stroke();
    }
    // Chordwise reinforcement tapes and a white centre stripe.
    ctx.fillStyle = 'rgba(255, 235, 230, 0.5)';
    ctx.fillRect(0, H * 0.3, W, 5);
    ctx.fillRect(0, H * 0.7, W, 5);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
    ctx.fillRect(W * 0.455, 0, W * 0.09, H);
    // Hem all round.
    ctx.strokeStyle = '#9d0a12';
    ctx.lineWidth = 22;
    ctx.strokeRect(0, 0, W, H);
  });
}

export function createParachute() {
  const group = new THREE.Group();
  group.name = 'parachute';
  group.visible = false;

  const material = new THREE.MeshStandardMaterial({
    map: canopyTexture(), roughness: 0.78, metalness: 0, side: THREE.DoubleSide,
    emissive: 0x3a0508, emissiveIntensity: 0.6,
  });
  const pilotMaterial = new THREE.MeshStandardMaterial({
    color: RED, roughness: 0.78, metalness: 0, side: THREE.DoubleSide, emissive: 0x3a0508, emissiveIntensity: 0.6,
  });
  // The square sheet: a flat grid in XZ (u across the span, v along the chord), lifted by archY.
  const dome = new THREE.PlaneGeometry(2 * HALF, 2 * HALF, 32, 32);
  dome.rotateX(-Math.PI / 2);
  const pos = dome.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, archY(pos.getX(i), pos.getZ(i)));
  dome.computeVertexNormals();
  // The canopy has its own transform (position, tilt, squash); the pilot chute
  // and the lines live in world space directly under `group`.
  const canopyGroup = new THREE.Group();
  canopyGroup.add(new THREE.Mesh(dome, material));
  group.add(canopyGroup);

  // Pilot chute and its line.
  const pilot = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 8, 0, Math.PI * 2, 0, CAP), pilotMaterial);
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
  const qYaw = new THREE.Quaternion();
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
      // Tilt to the canopy axis, then turn about it so the chord follows the drone's heading.
      canopyGroup.quaternion.copy(q.setFromUnitVectors(up, dir)).multiply(qYaw.setFromAxisAngle(up, Math.atan2(fwd.x, fwd.z)));
      canopyGroup.scale.set(sxz, sy, sxz);
      canopyGroup.updateMatrix();

      // Lines from the skirt to the two harness points (world space).
      for (let k = 0; k < LINES; k++) {
        edgePoint(k, rim);
        const front = rim.z > 0; // the canopy's +Z is the drone's heading
        rim.applyMatrix4(canopyGroup.matrix);
        const end = front ? A : B; // front half to the front point, rear half to the rear
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
