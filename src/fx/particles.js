import * as THREE from 'three';

// Stateless particle field: each particle's position, size and colour are a
// closed-form function of (uTime - birth), so the GPU can render any moment
// on the timeline directly, forwards or backwards.

export const MODE = { SMOKE: 0, FIRE: 1, SPLASH: 2, BURNING: 3, FUNNEL: 4 };

// Shared by every field: converts world size (m) to pixels.
export const pointScale = { value: 1 };

const vertexShader = /* glsl */ `
  attribute vec3 aVel;
  attribute float aBirth;
  attribute float aLife;
  attribute float aSeed;
  uniform float uTime, uDrag, uGravity, uRise, uScale;
  uniform vec2 uSize;
  uniform vec3 uWind;
  varying float vX;
  varying float vSeed;
  void main() {
    float age = uTime - aBirth;
    if (age < 0.0 || age >= aLife) {
      gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
      gl_PointSize = 0.0;
      vX = 2.0;
      return;
    }
    vec3 p = position + aVel * (1.0 - exp(-uDrag * age)) / uDrag + uWind * age;
    p.y += uRise * age - 0.5 * uGravity * age * age;
    vX = age / aLife;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float size = mix(uSize.x, uSize.y, sqrt(vX)) * (0.6 + 0.8 * aSeed);
    gl_PointSize = size * uScale / max(-mv.z, 0.5);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform int uMode;
  varying float vX;
  varying float vSeed;
  void main() {
    if (vX > 1.0) discard;
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    if (r > 1.0) discard;
    float soft = smoothstep(1.0, 0.15, r);
    vec3 col;
    float a;
    if (uMode == 0) {
      col = mix(vec3(0.97), vec3(0.7, 0.71, 0.73), vX) * (0.9 + 0.1 * vSeed);
      a = 0.55 * pow(1.0 - vX, 1.5);
    } else if (uMode == 1) {
      vec3 hot = vec3(1.0, 0.78, 0.4) * 4.0;
      vec3 mid = vec3(0.95, 0.32, 0.04) * 2.4;
      vec3 smoke = vec3(0.07, 0.065, 0.06);
      col = vX < 0.08 ? mix(hot, mid, vX / 0.08) : mix(mid, smoke, smoothstep(0.08, 0.3, vX));
      a = vX < 0.3 ? 0.95 : 0.85 * (1.0 - smoothstep(0.3, 1.0, vX));
    } else if (uMode == 2) {
      col = vec3(0.93, 0.96, 1.0);
      a = 0.85 * (1.0 - vX);
    } else if (uMode == 4) {
      // A ship's funnel exhaust: thin grey haze, darker where it is fresh, thinning as it spreads.
      col = mix(vec3(0.32, 0.32, 0.34), vec3(0.62, 0.63, 0.66), vX) * (0.9 + 0.1 * vSeed);
      a = 0.3 * pow(1.0 - vX, 1.4) * smoothstep(0.0, 0.05, vX);
    } else {
      col = vX < 0.07 ? mix(vec3(1.0, 0.55, 0.12) * 3.0, vec3(0.16), vX / 0.07) : mix(vec3(0.15), vec3(0.42), vX);
      a = 0.65 * pow(1.0 - vX, 1.3);
    }
    gl_FragColor = vec4(col, a * soft);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class ParticleField extends THREE.Points {
  constructor(capacity, {
    mode = MODE.SMOKE, drag = 1, gravity = 0, rise = 0, size = [1, 5], wind = [0, 0, 0],
  } = {}) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    geo.setAttribute('aVel', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    geo.setAttribute('aBirth', new THREE.BufferAttribute(new Float32Array(capacity), 1));
    geo.setAttribute('aLife', new THREE.BufferAttribute(new Float32Array(capacity), 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(capacity), 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDrag: { value: Math.max(drag, 1e-3) },
        uGravity: { value: gravity },
        uRise: { value: rise },
        uSize: { value: new THREE.Vector2(...size) },
        uWind: { value: new THREE.Vector3(...wind) },
        uMode: { value: mode },
        uScale: pointScale,
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
    });
    super(geo, mat);
    this.capacity = capacity;
    this.count = 0;
    this.frustumCulled = false;
    this.isParticleField = true;
    this._perm = null;
  }

  add(origin, vel, birth, life, seed) {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    const a = this.geometry.attributes;
    a.position.setXYZ(i, origin.x, origin.y, origin.z);
    a.aVel.setXYZ(i, vel.x, vel.y, vel.z);
    a.aBirth.setX(i, birth);
    a.aLife.setX(i, life);
    a.aSeed.setX(i, seed);
  }

  finalize() {
    this.geometry.setDrawRange(0, this.count);
    for (const attr of Object.values(this.geometry.attributes)) attr.needsUpdate = true;
    return this;
  }

  // Draw only a fraction of the baked particles. A fixed low-discrepancy order
  // (golden-ratio sort) makes every prefix an even spread over the whole life of
  // the effect, so nothing is re-baked and the result is the same every time.
  setDensity(f) {
    if (!this.count) return;
    if (f >= 1) {
      if (this._perm) this.geometry.setIndex(null);
      this._perm = null;
      this.geometry.setDrawRange(0, this.count);
      return;
    }
    if (!this._perm) {
      const order = Array.from({ length: this.count }, (_, i) => i);
      const key = (i) => (i * 0.6180339887498949) % 1;
      order.sort((a, b) => key(a) - key(b));
      this._perm = new Uint32Array(order);
      this.geometry.setIndex(new THREE.BufferAttribute(this._perm, 1));
    }
    this.geometry.setDrawRange(0, Math.max(1, Math.ceil(this.count * f)));
  }

  setTime(t) {
    this.material.uniforms.uTime.value = t;
  }
}
