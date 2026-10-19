import * as THREE from 'three';

// The drone's engine: a horizontally opposed two-cylinder two-stroke, modelled on the reference photo of
// the real unit. Two big finned cylinders point out to either side of a cast crankcase; the cylinder
// heads are finned too and carry the spark plugs, with silver elbow caps and thick black leads running
// back over the crankcase; a green carburettor sits on an angled intake manifold on top, ending in a
// flared copper intake bell; a round magneto housing closes the back of the crankcase; and at the front
// an orange anodised flange with a ring of four steel-blue bolts carries the propeller.
//
// Plane coordinates: the nose is +Z, the left wing +X, up is +Y; the crankshaft runs along Z through
// (0, ENGINE_Y, ENGINE_Z). The engine fits in a box about 0.60 m wide (X), 0.42 m long (Z, firewall to
// flange) and 0.4 m high with the carburettor. addEngine() adds the engine proper to the fuselage's Kit
// (so it breaks away with the fuselage); addFlange() adds the propeller flange to the prop's Kit, in
// the prop's own frame (origin on the shaft, axis +Z), so it spins with the propeller.
//
// `M` is a set of materials: { alu, metal, dark, black, white, copper, green, blue, orange }; `copper`
// should be double sided (the bell is open).

export const ENGINE_Y = 0.07;
export const ENGINE_Z = 2.06;

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

// A tapered tube from point a to point b (radius r0 at a, r1 at b), open or capped.
function tube(k, a, b, r0, r1, material, seg = 16, open = false) {
  _a.set(...a);
  _b.set(...b);
  const len = _a.distanceTo(_b);
  _q.setFromUnitVectors(_up, _b.clone().sub(_a).normalize());
  _m.compose(_a.clone().add(_b).multiplyScalar(0.5), _q, _s);
  k.add(new THREE.CylinderGeometry(r1, r0, len, seg, 1, open), material, _m);
}

// A cylinder along X, centred at (x, y, z).
const alongX = (k, r, len, material, x, y, z, seg = 24) => k.add(new THREE.CylinderGeometry(r, r, len, seg), material, { pos: [x, y, z], rot: [0, 0, Math.PI / 2] });
// A cylinder along Z.
const alongZ = (k, r, len, material, x, y, z, seg = 24) => k.add(new THREE.CylinderGeometry(r, r, len, seg), material, { pos: [x, y, z], rot: [Math.PI / 2, 0, 0] });
// A hex bolt head standing on +Y / along a Z or X axis.
const hexX = (k, r, len, material, x, y, z) => k.add(new THREE.CylinderGeometry(r, r, len, 6), material, { pos: [x, y, z], rot: [0, 0, Math.PI / 2] });
const hexY = (k, r, len, material, x, y, z) => k.add(new THREE.CylinderGeometry(r, r, len, 6), material, { pos: [x, y, z] });
const hexZ = (k, r, len, material, x, y, z) => k.add(new THREE.CylinderGeometry(r, r, len, 6), material, { pos: [x, y, z], rot: [Math.PI / 2, 0, 0] });

export function addEngine(k, M) {
  const { alu, metal, dark, black, green, copper } = M;
  const Y = ENGINE_Y;
  const Z = ENGINE_Z;

  // --- Magneto housing: the round cover on the back of the crankcase, with a lip and bolts.
  alongZ(k, 0.083, 0.03, alu, 0, Y, Z - 0.13, 32);
  alongZ(k, 0.09, 0.008, alu, 0, Y, Z - 0.112, 32);
  alongZ(k, 0.04, 0.014, dark, 0, Y, Z - 0.15, 20);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    hexZ(k, 0.0065, 0.01, metal, Math.cos(a) * 0.066, Y + Math.sin(a) * 0.066, Z - 0.147);
  }

  // --- Crankcase: a cast block with a top plate, bolts, and the bearing housing at the front.
  k.add(new THREE.BoxGeometry(0.17, 0.2, 0.22), alu, { pos: [0, Y, Z] });
  k.add(new THREE.BoxGeometry(0.2, 0.012, 0.25), alu, { pos: [0, Y + 0.106, Z] }); // top flange
  k.add(new THREE.BoxGeometry(0.19, 0.012, 0.24), alu, { pos: [0, Y - 0.106, Z] }); // sump flange
  for (const x of [-0.075, 0.075]) {
    for (const dz of [-0.1, 0, 0.1]) hexY(k, 0.009, 0.012, metal, x, Y + 0.118, Z + dz);
  }
  alongZ(k, 0.06, 0.05, alu, 0, Y, Z + 0.135, 28); // bearing housing
  alongZ(k, 0.066, 0.006, metal, 0, Y, Z + 0.112, 28); // its seat
  alongZ(k, 0.046, 0.012, dark, 0, Y, Z + 0.164, 24); // oil seal
  alongZ(k, 0.022, 0.07, metal, 0, Y, Z + 0.18, 16); // crankshaft

  // --- The two cylinders, one each side.
  for (const s of [-1, 1]) {
    // Mounting flange and studs.
    k.add(new THREE.BoxGeometry(0.014, 0.15, 0.15), alu, { pos: [s * 0.092, Y, Z] });
    for (const [dy, dz] of [[0.06, 0.06], [-0.06, 0.06], [0.06, -0.06], [-0.06, -0.06]]) hexX(k, 0.008, 0.014, metal, s * 0.1, Y + dy, Z + dz);
    // Barrel and its cooling fins.
    alongX(k, 0.058, 0.11, alu, s * 0.152, Y, Z);
    for (let i = 0; i < 9; i++) alongX(k, 0.084, 0.0065, alu, s * (0.105 + i * 0.0105), Y, Z);
    // Head: a core, six closer fins, and a cap.
    alongX(k, 0.07, 0.07, alu, s * 0.235, Y, Z);
    for (let j = 0; j < 6; j++) alongX(k, 0.092, 0.006, alu, s * (0.205 + j * 0.012), Y, Z);
    alongX(k, 0.048, 0.03, alu, s * 0.285, Y, Z, 20);
    hexX(k, 0.02, 0.012, metal, s * 0.3, Y, Z);
    // Spark plug on the front of the head, with a silver elbow cap and a thick black lead.
    const px = s * 0.235;
    tube(k, [px, Y + 0.04, Z + 0.07], [px, Y + 0.07, Z + 0.12], 0.014, 0.012, metal, 10);
    tube(k, [px, Y + 0.07, Z + 0.12], [px, Y + 0.088, Z + 0.17], 0.02, 0.017, alu, 14);
    tube(k, [px, Y + 0.088, Z + 0.17], [px, Y + 0.092, Z + 0.19], 0.016, 0.014, black, 10);
    // The lead: thick, a short arc up over the head and back to the manifold.
    const lead = [[px, Y + 0.09, Z + 0.185], [s * 0.2, Y + 0.125, Z + 0.15], [s * 0.15, Y + 0.155, Z + 0.1], [s * 0.095, Y + 0.17, Z + 0.045], [s * 0.05, Y + 0.165, Z + 0.0]];
    for (let i = 0; i + 1 < lead.length; i++) k.rod(lead[i], lead[i + 1], 0.0155, black, 10);
    for (let i = 1; i + 1 < lead.length; i++) k.add(new THREE.SphereGeometry(0.0155, 10, 8), black, { pos: lead[i] }); // smooth the elbows
    // Exhaust header from the lower rear of the head down to the muffler.
    k.rod([s * 0.225, Y - 0.04, Z - 0.03], [s * 0.12, Y - 0.19, Z - 0.07], 0.017, copper, 8);
  }

  // --- Intake: manifold up from the top plate, the green carburettor, the flared copper bell.
  k.add(new THREE.CylinderGeometry(0.042, 0.042, 0.012, 20), alu, { pos: [0, Y + 0.118, Z - 0.015] }); // manifold flange
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    hexY(k, 0.006, 0.01, metal, Math.cos(a) * 0.032, Y + 0.127, Z - 0.015 + Math.sin(a) * 0.032);
  }
  tube(k, [0, Y + 0.118, Z - 0.015], [0, Y + 0.19, Z - 0.07], 0.034, 0.03, alu, 18); // the elbow, leaning back
  tube(k, [0, Y + 0.19, Z - 0.07], [0, Y + 0.235, Z - 0.118], 0.03, 0.03, alu, 18);
  tube(k, [0, Y + 0.235, Z - 0.118], [0, Y + 0.30, Z - 0.185], 0.043, 0.043, green, 20); // carburettor body
  k.add(new THREE.CylinderGeometry(0.03, 0.03, 0.045, 18), green, { pos: [0, Y + 0.21, Z - 0.135] }); // float bowl
  k.add(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 8), metal, { pos: [0, Y + 0.18, Z - 0.135] }); // its drain screw
  alongX(k, 0.012, 0.05, metal, 0.05, Y + 0.275, Z - 0.145, 10); // throttle shaft
  k.rod([0.075, Y + 0.275, Z - 0.145], [0.075, Y + 0.31, Z - 0.17], 0.005, black, 5); // throttle arm
  hexX(k, 0.01, 0.014, metal, -0.058, Y + 0.268, Z - 0.138); // mixture screw
  tube(k, [0, Y + 0.30, Z - 0.185], [0, Y + 0.355, Z - 0.24], 0.04, 0.082, copper, 28, true); // the bell
  tube(k, [0, Y + 0.3, Z - 0.185], [0, Y + 0.336, Z - 0.222], 0.032, 0.056, dark, 20, true); // its throat (dark inside)

  // The underside: a drain plug.
  hexY(k, 0.012, 0.012, metal, 0, Y - 0.12, Z);
}

// The propeller flange: orange anodised, with four steel-blue bolts on a bolt circle and a steel boss.
export function addFlange(k, M) {
  const { metal, blue, orange } = M;
  k.add(new THREE.CylinderGeometry(0.078, 0.078, 0.014, 36), orange, { pos: [0, 0, -0.012], rot: [Math.PI / 2, 0, 0] });
  k.add(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 24), metal, { pos: [0, 0, 0.02], rot: [Math.PI / 2, 0, 0] }); // hub boss
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a) * 0.058;
    const y = Math.sin(a) * 0.058;
    k.add(new THREE.CylinderGeometry(0.0115, 0.0115, 0.02, 6), blue, { pos: [x, y, 0.005], rot: [Math.PI / 2, 0, 0] }); // bolt head
    k.add(new THREE.CylinderGeometry(0.017, 0.017, 0.003, 14), metal, { pos: [x, y, -0.003], rot: [Math.PI / 2, 0, 0] }); // washer
  }
  k.add(new THREE.CylinderGeometry(0.012, 0.012, 0.06, 8), metal, { pos: [0, 0, 0.05], rot: [Math.PI / 2, 0, 0] }); // shaft end
}
