import * as THREE from 'three';

// A 30 mm seven-barrel rotary gun in its mount (the kind used for close-in defence), about 3 m long. The mount is in the
// ship's frame: the base sits at the origin, the turret yaws about +Y (positive yaw turns the muzzle toward port, the same
// convention as the missile launcher), the gun pitches about +Z, and the muzzle points along +X.
// The seven barrels (one in the middle, six round it) spin together as a block while it fires.

const grey = new THREE.MeshStandardMaterial({ color: 0x8c949b, roughness: 0.55, metalness: 0.35 });
const greyLight = new THREE.MeshStandardMaterial({ color: 0xb4bbc0, roughness: 0.5, metalness: 0.3 });
const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.45, metalness: 0.7 });
const steel = new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.3, metalness: 0.9 });

export const GATLING_BARREL_LENGTH = 1.9;
export const GATLING_MUZZLE_X = 2.35; // from the pitch pivot, along the barrels

export function createGatling() {
  const group = new THREE.Group();
  // Base ring and pedestal.
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.1, 0.42, 20), grey);
  base.position.y = 0.21;
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.78, 0.7, 18), greyLight);
  stalk.position.y = 0.77;
  group.add(base, stalk);

  // Turret: a rounded housing with the gun's side bays.
  const yawGroup = new THREE.Group();
  yawGroup.position.y = 1.12;
  group.add(yawGroup);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.95, 1.5), greyLight);
  housing.position.y = 0.35;
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.78, 0.5, 16), grey);
  dome.position.set(-0.15, 0.95, 0);
  const ammoBox = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.75, 1.9), grey); // the drum and its feed, behind the pivot
  ammoBox.position.set(-0.55, 0.35, 0);
  yawGroup.add(housing, dome, ammoBox);

  // The gun: pivots on the housing's front.
  const pitchGroup = new THREE.Group();
  pitchGroup.position.set(0.45, 0.55, 0);
  yawGroup.add(pitchGroup);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.46, 1.1, 18), dark);
  body.rotation.z = -Math.PI / 2;
  body.position.x = 0.25;
  pitchGroup.add(body);

  // The barrel block: spins about +X.
  const spin = new THREE.Group();
  spin.position.x = 0.8;
  pitchGroup.add(spin);
  const barrelGeo = new THREE.CylinderGeometry(0.052, 0.052, GATLING_BARREL_LENGTH, 8);
  const ringR = 0.2;
  for (let i = 0; i < 7; i++) {
    const a = ((i - 1) / 6) * Math.PI * 2;
    const b = new THREE.Mesh(barrelGeo, steel);
    b.rotation.z = -Math.PI / 2;
    b.position.set(GATLING_BARREL_LENGTH / 2, i === 0 ? 0 : Math.sin(a) * ringR, i === 0 ? 0 : Math.cos(a) * ringR);
    spin.add(b);
  }
  for (const x of [0.15, 0.95, GATLING_BARREL_LENGTH - 0.08]) { // the clamps holding the block together
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(ringR + 0.075, ringR + 0.075, 0.1, 16), dark);
    ring.rotation.z = -Math.PI / 2;
    ring.position.x = x;
    spin.add(ring);
  }
  // The muzzle: where the rounds start, and a flash that shows while it fires.
  const muzzle = new THREE.Object3D();
  muzzle.position.x = GATLING_MUZZLE_X;
  pitchGroup.add(muzzle);
  const flash = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 1.7, 10),
    new THREE.MeshBasicMaterial({ color: 0xffc46a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  flash.rotation.z = -Math.PI / 2;
  flash.position.x = 0.85;
  flash.visible = false;
  muzzle.add(flash);
  const light = new THREE.PointLight(0xffa850, 0, 38, 1.6);
  light.position.x = 1.2;
  muzzle.add(light);

  for (const o of [base, stalk, housing, dome, ammoBox, body]) { o.castShadow = true; o.receiveShadow = true; }
  for (const o of spin.children) o.castShadow = true;

  return {
    group, yawGroup, pitchGroup, spin, muzzle, flash, light,
    // yaw, pitch: the gun's aim in the ship's frame; spinAngle: the barrel block's turn; firing: show the flash.
    pose(yaw, pitch, spinAngle, firing, t = 0) {
      yawGroup.rotation.y = yaw;
      pitchGroup.rotation.z = pitch;
      spin.rotation.x = spinAngle;
      // Recoil: the whole gun shudders back and forth about once a round, the housing shaking with it.
      const k = firing ? 1 : 0;
      pitchGroup.position.x = 0.45 - k * (0.035 + 0.03 * Math.abs(Math.sin(t * 260)));
      yawGroup.position.y = 1.12 + k * 0.012 * Math.sin(t * 310);
      yawGroup.position.z = k * 0.01 * Math.sin(t * 280 + 1);
      // The flash: a ragged bright cone, on most of the time with quick gaps, longer and shorter at random.
      const on = firing && Math.sin(t * 410) + Math.sin(t * 173 + 2) > -1.1;
      flash.visible = on;
      if (on) {
        flash.scale.set(0.7 + 0.9 * Math.abs(Math.sin(t * 97 + 1)) + 0.4 * Math.abs(Math.sin(t * 331)), 0.8 + 0.5 * Math.abs(Math.sin(t * 131)), 0.8 + 0.5 * Math.abs(Math.sin(t * 211)));
        flash.rotation.x = t * 40;
      }
      light.intensity = on ? 4 + 3 * Math.abs(Math.sin(t * 150)) : 0;
    },
  };
}
