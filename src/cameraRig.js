import * as THREE from 'three';

// Click-to-focus camera. On focus it eases the orbit target onto the object
// and dollies to a sensible distance; afterwards it carries the camera along
// with the object's per-frame movement so the user's orbit angle is kept.
export class CameraRig {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.id = 'free';
    this.getPos = null;
    this.last = new THREE.Vector3();
    this.transition = null;
    this._p = new THREE.Vector3();
  }

  focus(id, getPos, distance, minDistance) {
    this.id = id;
    this.getPos = getPos;
    getPos(this.last);
    this.controls.minDistance = minDistance;
    this.transition = {
      start: performance.now(),
      duration: 900,
      fromTarget: this.controls.target.clone(),
      fromOffset: this.camera.position.clone().sub(this.controls.target),
      toDistance: distance,
    };
  }

  free() {
    this.id = 'free';
    this.getPos = null;
    this.transition = null;
    this.controls.minDistance = 2;
  }

  update() {
    if (!this.getPos) return;
    const p = this.getPos(this._p);
    const { camera, controls } = this;
    if (this.transition) {
      const tr = this.transition;
      const k = Math.min((performance.now() - tr.start) / tr.duration, 1);
      const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
      controls.target.lerpVectors(tr.fromTarget, p, e);
      const len = THREE.MathUtils.lerp(tr.fromOffset.length(), tr.toDistance, e);
      camera.position.copy(controls.target).addScaledVector(tr.fromOffset, len / tr.fromOffset.length());
      if (k >= 1) this.transition = null;
    } else {
      const delta = this.last.sub(p).negate(); // p - last, reusing `last`
      camera.position.add(delta);
      controls.target.add(delta);
    }
    this.last.copy(p);
  }
}
