import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mulberry32 } from './rng.js';

const SUN_ELEVATION = 24; // degrees
const SUN_AZIMUTH = 215;
const HORIZON = new THREE.Color(0.66, 0.74, 0.84);
const ZENITH = new THREE.Color(0.2, 0.38, 0.66);
// Linear colours picked so that, after the ACES tone mapping the renderer uses, they come out as a true blue
// (about sRGB 135 190 245 at the horizon and 28 102 229 overhead). Plain mid-range values come out grey.
const CALM_HORIZON = new THREE.Color(0.06, 0.56, 3.0);
const CALM_ZENITH = new THREE.Color(0, 0.16, 1.4);

// `calm` is the drill's look: a deeper, quieter sea and a bluer sky, so ships and readouts stand out (flatter
// distant waves with no moire stripes, less sky reflection and glitter).
export function createEnvironment(renderer, scene, { calm = false } = {}) {
  const horizon = calm ? CALM_HORIZON : HORIZON;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(
    1, THREE.MathUtils.degToRad(90 - SUN_ELEVATION), THREE.MathUtils.degToRad(SUN_AZIMUTH),
  );

  const sky = new Sky();
  sky.scale.setScalar(20000);
  const u = sky.material.uniforms;
  u.turbidity.value = calm ? 1.2 : 5;
  u.rayleigh.value = calm ? 3.2 : 1.4;
  u.mieCoefficient.value = calm ? 0.0012 : 0.004;
  u.mieDirectionalG.value = 0.82;
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);
  // The drill's sky: a gradient dome in saturated blue instead of the physical Sky (which tone-maps to grey). The
  // Sky object still lights the scene through the environment map below.
  let dome = null;
  if (calm) {
    sky.visible = false;
    dome = new THREE.Mesh(
      new THREE.SphereGeometry(20000, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: { uHorizon: { value: CALM_HORIZON }, uZenith: { value: CALM_ZENITH }, uSun: { value: sunDir } },
        vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `
          uniform vec3 uHorizon, uZenith, uSun;
          varying vec3 vDir;
          void main() {
            float h = clamp(vDir.y, 0.0, 1.0);
            vec3 col = mix(uHorizon, uZenith, pow(h, 0.45));
            float s = max(dot(normalize(vDir), uSun), 0.0);
            col += vec3(1.0, 0.85, 0.55) * (pow(s, 40.0) * 0.5 + pow(s, 900.0) * 6.0);
            gl_FragColor = vec4(col, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    dome.renderOrder = -2;
    dome.frustumCulled = false;
    scene.add(dome);
  }

  // Image-based lighting from the same sky.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const skyScene = new THREE.Scene();
  const skyClone = new Sky();
  skyClone.material.uniforms = THREE.UniformsUtils.clone(u);
  skyClone.scale.setScalar(1000);
  skyScene.add(skyClone);
  scene.environment = pmrem.fromScene(skyScene).texture;
  scene.environmentIntensity = 0.7;
  pmrem.dispose();

  scene.fog = new THREE.Fog(horizon, 3000, 16000);

  const sun = new THREE.DirectionalLight(0xfff1dc, 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.4;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x203040, 0.6));

  const ocean = createOcean(sunDir, calm, horizon);
  scene.add(ocean);
  const clouds = createClouds(calm);
  const mountains = calm ? createMountains() : null;
  if (mountains) scene.add(mountains);
  scene.add(clouds);
  const CLOUD_PERIOD = 26000; // the cloud field repeats this often, so it never runs out under a far-flying camera

  return {
    sunDir,
    ocean,
    // For a camera that travels far from the origin (the manual-flight mission): the sky dome and the WebGL
    // sea plane ride along with it, and the clouds wrap around it, so the world never ends.
    follow(camPos) {
      sky.position.set(camPos.x, 0, camPos.z);
      dome?.position.set(camPos.x, 0, camPos.z);
      mountains?.position.set(camPos.x, 0, camPos.z); // a backdrop at infinity: the ships can never sail into it
      ocean.position.x = camPos.x;
      ocean.position.z = camPos.z;
      for (const c of clouds.children) {
        const b = c.userData.base;
        c.position.x = b.x + Math.round((camPos.x - b.x) / CLOUD_PERIOD) * CLOUD_PERIOD;
        c.position.z = b.z + Math.round((camPos.z - b.z) / CLOUD_PERIOD) * CLOUD_PERIOD;
        if (calm) { // a cloud the camera comes close to (a far zoom-out) fades away instead of filling the view
          const near = c.scale.x * 0.7;
          const k = Math.min(Math.max((c.position.distanceTo(camPos) - near) / near, 0), 1);
          c.material.opacity = c.userData.opacity * k;
          c.visible = k > 0;
        }
      }
    },
    // Smaller shadow map for the lower quality tiers (the old map is freed and rebuilt on the next frame).
    setShadowSize(n) {
      if (sun.shadow.mapSize.x === n) return;
      sun.shadow.mapSize.set(n, n);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    },
    // Shadow frustum follows whatever the camera is looking at.
    setShadowFocus(center, halfSize) {
      sun.target.position.copy(center);
      sun.position.copy(center).addScaledVector(sunDir, 800);
      const cam = sun.shadow.camera;
      if (cam.right !== halfSize) {
        cam.left = cam.bottom = -halfSize;
        cam.right = cam.top = halfSize;
        cam.near = 100;
        cam.far = 1600;
        cam.updateProjectionMatrix();
      }
    },
  };
}

// Analytic ocean, kept deliberately simple so the frame rate stays high: a slightly choppy sea from five
// octaves of value noise (features of about 48, 24, 12, 6 and 3 m), evaluated per fragment for the normal
// only (the surface itself stays flat), a sky gradient reflected by Fresnel, the sun's glitter, and a cheap
// wake. No noise textures, no environment lookups. Noise, not sine waves: long swells rolled under the moving
// ships and looked dizzying, and a few crossed sines read as parallel bands or a crosshatch. Each octave is
// rotated and drifts slowly its own way, as a function of scene time, so it rewinds with the timeline.
function createOcean(sunDir, calm, horizon) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color(1.0, 0.93, 0.8) },
      uCalm: { value: calm ? 1 : 0 },
      uGrid: { value: 0 }, // the drill's tactical grid: on or off
      uGridCell: { value: 457.2 }, // 500 yd squares, north up
      uRingC: { value: new THREE.Vector2() }, // the range rings' centre (ALG), world x z
      uDeep: { value: calm ? new THREE.Color(0.012, 0.075, 0.13) : new THREE.Color(0.006, 0.045, 0.085) },
      uScatter: { value: calm ? new THREE.Color(0.03, 0.18, 0.24) : new THREE.Color(0.02, 0.13, 0.16) },
      uHorizon: { value: horizon },
      uZenith: { value: calm ? CALM_ZENITH : ZENITH },
      uFogNear: { value: 3000 },
      uFogFar: { value: 16000 },
      uShipX: { value: 0 }, // ship position along +X, drives the wake
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      #define CHOP_OCTAVES 5
      #define CHOP_SLOPE 0.085 // slope per octave, about equal at every scale (calm: 60 %)
      #define CHOP_DRIFT 0.7 // m/s each octave drifts
      uniform float uTime;
      uniform vec3 uSunDir, uSunColor, uDeep, uScatter, uHorizon, uZenith;
      uniform float uFogNear, uFogFar, uShipX, uCalm, uGrid, uGridCell;
      uniform vec2 uRingC;
      varying vec3 vWorld;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      // Value noise with its analytic gradient (xy = d/dp, z = value), on a sin-free hash that keeps its
      // precision far from the origin.
      float hash2(vec2 p) {
        p = 50.0 * fract(p * 0.3183099 + vec2(0.71, 0.113));
        return fract(p.x * p.y * (p.x + p.y));
      }
      vec3 noised(vec2 x) {
        vec2 i = floor(x), f = fract(x);
        vec2 u = f * f * (3.0 - 2.0 * f);
        vec2 du = 6.0 * f * (1.0 - f);
        float a = hash2(i), b = hash2(i + vec2(1, 0)), c = hash2(i + vec2(0, 1)), d = hash2(i + vec2(1, 1));
        float k = a - b - c + d;
        return vec3(du * (vec2(b - a, c - a) + k * u.yx), a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y);
      }
      // Slope of the chop: each octave rotated (so no direction lines up across scales), drifting its own way,
      // and faded out once its features shrink toward a pixel (fp: metres per pixel), before it shimmers.
      vec2 chopGrad(vec2 p, float fp, float slope) {
        vec2 g = vec2(0.0);
        float F = 48.0;
        float ang = 0.4;
        for (int o = 0; o < CHOP_OCTAVES; o++) {
          float c = cos(ang), s = sin(ang);
          mat2 R = mat2(c, s, -s, c);
          vec2 drift = vec2(cos(ang * 2.3 + 1.0), sin(ang * 2.3 + 1.0)) * (CHOP_DRIFT * uTime);
          vec3 n = noised(R * (p + drift) / F + float(o) * 17.3);
          float fade = 1.0 - smoothstep(0.12 * F, 0.4 * F, fp);
          g += (n.xy * R) * (slope * fade); // d/dp of n(R p / F) * F * slope / F
          F *= 0.5;
          ang += 1.37;
        }
        return g;
      }
      // A thin line (about one pixel) where d, a distance in pixels, is small.
      float ringAt(float rr, float R, float w) { return 1.0 - min(abs(rr - R) / w, 1.0); }
      // Waterline half-beam of the frigate (mirrors widthFactor() in ship.js).
      float hullHalf(float x) {
        float u = (x + 60.0) / 115.5;
        if (u < 0.0 || u > 1.0) return -1.0;
        float w = u < 0.56 ? 0.93 + 0.07 * min(u / 0.12, 1.0) : pow(max(0.0, 1.0 - pow((u - 0.56) / 0.44, 2.1)), 0.62);
        return 6.35 * w;
      }
      // Foam: bow wave hugging the hull, churned wake astern and faint Kelvin arms, broken up by two
      // samples of noise so it reads as patches, not painted stripes.
      float wakeFoam(vec2 p, float dist) {
        float x = p.x - uShipX;
        float az = abs(p.y);
        float f = 0.0;
        float w = hullHalf(x);
        if (w >= 0.0) {
          float u = (x + 60.0) / 115.5;
          f = max(f, smoothstep(3.5, 0.0, az - w) * (0.35 + 0.65 * u * u));
        }
        if (x < -57.0) {
          float b = -57.0 - x;
          float q = az / (5.0 + 0.045 * b);
          f = max(f, exp(-q * q) * exp(-b / 260.0));
        }
        if (x < 52.0) {
          float b = 52.0 - x;
          float d = (az - (0.36 * b + 5.0)) / (1.2 + 0.02 * b);
          f = max(f, exp(-d * d) * exp(-b / 160.0) * 0.45 * smoothstep(0.0, 20.0, b));
        }
        float n = vnoise(p * 0.3 + vec2(uTime * 0.03, -uTime * 0.02));
        float n2 = vnoise(p * 1.3 - uTime * 0.1);
        float patchy = smoothstep(0.55 - 0.45 * f, 0.9 - 0.3 * f, n * 0.7 + n2 * 0.3);
        return clamp(f * patchy * 1.4, 0.0, 1.0) * (1.0 - smoothstep(1500.0, 4000.0, dist));
      }

      void main() {
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        float fp = length(fwidth(vWorld.xz));
        vec2 grad = chopGrad(vWorld.xz, fp, CHOP_SLOPE * mix(1.0, 0.6, uCalm));
        vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
        // Distant water flattens toward a smooth average normal.
        n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(mix(800.0, 250.0, uCalm), mix(6000.0, 2500.0, uCalm), dist) * mix(0.6, 0.85, uCalm)));
        vec3 v = toCam / dist;
        float ndv = max(dot(n, v), 0.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        vec3 r = reflect(-v, n);
        r.y = abs(r.y);
        vec3 sky = mix(uHorizon, uZenith, pow(clamp(r.y, 0.0, 1.0), 0.55));
        // Subsurface tint on wave faces turned toward the viewer.
        float sss = pow(max(dot(normalize(vec3(grad.x, 0.2, grad.y)), -v), 0.0), 2.0);
        vec3 water = mix(uDeep, uScatter, 0.25 + 0.5 * ndv * ndv + 0.6 * sss);
        float sunDot = max(dot(r, uSunDir), 0.0);
        vec3 spec = uSunColor * (pow(sunDot, 700.0) * 5.0 + pow(sunDot, 70.0) * 0.12) * mix(1.0, 0.0, uCalm); // no sun glitter in the drill
        vec3 col = mix(water, sky, fresnel * mix(0.9, 0.55, uCalm)) + spec;
        float foam = wakeFoam(vWorld.xz, dist);
        vec3 foamCol = vec3(0.82, 0.87, 0.9) * (0.55 + 0.45 * max(uSunDir.y, 0.0));
        col = mix(col, foamCol, foam);
        if (uGrid > 0.5) {
          // Tactical grid: 500 yd squares (every second line brighter) aligned to north, and solid range rings
          // at 250, 500 and 1000 yd round ALG. Antialiased by the pixel footprint, fading with distance.
          vec2 g = vWorld.xz / uGridCell;
          vec2 w = max(fwidth(g), vec2(1e-5));
          vec2 dm = abs(fract(g - 0.5) - 0.5) / w;
          float minor = 1.0 - min(min(dm.x, dm.y), 1.0);
          vec2 g2 = g * 0.5;
          vec2 w2 = max(fwidth(g2), vec2(1e-5));
          vec2 dM = abs(fract(g2 - 0.5) - 0.5) / w2;
          float major = 1.0 - min(min(dM.x, dM.y), 1.0);
          float dense = 1.0 - smoothstep(0.06, 0.2, max(w.x, w.y)); // lines packed closer than a few pixels vanish: no shimmer
          float vis = (1.0 - smoothstep(700.0, 3200.0, dist)) * dense;
          vec2 rp = vWorld.xz - uRingC;
          float rr = length(rp);
          float wr = max(fwidth(rr), 1e-4);
          float ring = max(max(ringAt(rr, 228.6, wr), ringAt(rr, 457.2, wr)), ringAt(rr, 914.4, wr));
          float rv = 1.0 - smoothstep(1500.0, 5000.0, dist);
          float a = max((minor * 0.09 + major * 0.15) * vis, ring * 0.32 * rv);
          col = mix(col, vec3(0.68, 0.94, 0.3), a);
        }
        col = mix(col, uHorizon, smoothstep(uFogNear, uFogFar, dist));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const geo = new THREE.PlaneGeometry(60000, 60000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'ocean';
  return mesh;
}

// Scattered fair-weather cumulus: soft billboard sprites from a generated
// texture, far enough away that parallax sells them.
function createClouds(calm = false) {
  const rng = mulberry32(77);
  const textures = [0, 1, 2].map((seed) => {
    const r = mulberry32(seed + 5);
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const ctx = c.getContext('2d');
    for (let i = 0; i < 70; i++) {
      const x = 80 + r() * 352;
      const y = 150 - r() * 70 * Math.sin(((x - 80) / 352) * Math.PI);
      const rad = 25 + r() * 55;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      let shade = 225 + r() * 30;
      if (calm) {
        // Crisper, whiter puffs with a soft blue-grey underside, so each cloud reads against the blue sky.
        shade = 255 - Math.max(0, (y - 90) / 70) * 55;
        g.addColorStop(0, `rgba(${shade},${shade},${Math.min(255, shade + 6)},0.95)`);
        g.addColorStop(0.6, `rgba(${shade},${shade},${Math.min(255, shade + 6)},0.7)`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
      } else {
        g.addColorStop(0, `rgba(${shade},${shade},${shade + 3},0.5)`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
      }
      ctx.fillStyle = g;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
  const group = new THREE.Group();
  for (let i = 0; i < (calm ? 70 : 38); i++) {
    const a = rng() * Math.PI * 2;
    const d = 2500 + rng() * (calm ? 11000 : 9000);
    const size = calm ? 900 + rng() * 1600 : 700 + rng() * 1300;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: textures[i % 3], transparent: true, depthWrite: false, fog: false, opacity: (calm ? 0.88 : 0.75) + rng() * (calm ? 0.12 : 0.25),
      color: new THREE.Color(2.3, 2.3, 2.4), // above 1 so tone mapping keeps them as bright as the sky
    }));
    // The calm (drill) clouds ride high, 3,000 to 4,800 m, above where the camera works, so they never cross the view.
    sprite.position.set(Math.cos(a) * d, (calm ? 3000 : 900) + rng() * (calm ? 1800 : 1400), Math.sin(a) * d);
    sprite.userData.base = sprite.position.clone();
    sprite.userData.opacity = sprite.material.opacity;
    sprite.scale.set(size, size * 0.5, 1);
    group.add(sprite);
  }
  return group;
}

// Distant mountains for the drill: three ranges on the horizon in an arc, each one mesh of flat-coloured triangles (no textures, no
// lighting): jagged ridged-noise peaks, lit a little on the side that faces the sun, with soft spurs running down their slopes, and bluer and hazier toward the sea and the
// farther away they are. Static, far enough that moving the camera barely shifts them.
const MOUNT_ARC = [-0.3, 3.4]; // radians: an arc of about 210 degrees
const MOUNT_LAYERS = (() => {
  const rng = mulberry32(31);
  return [
    { r: 13000, h: 1150, col: [0.36, 0.5, 0.74], haze: 0.22, n: 900 },
    { r: 10600, h: 850, col: [0.2, 0.32, 0.54], haze: 0.12, n: 900 },
    { r: 8800, h: 580, col: [0.1, 0.2, 0.34], haze: 0.04, n: 900 },
  ].map((L) => ({ ...L, p: [rng() * 100, rng() * 100, rng() * 100] }));
})();
const hash1 = (i) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x) { // smooth value noise in 0..1
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}
function ridged(x, seed) { // sharp-crested peaks: 1 - |noise| squared, four octaves
  let s = 0;
  let amp = 0.5;
  let fr = 1;
  let norm = 0;
  for (let o = 0; o < 3; o++) {
    const n = 1 - Math.abs(2 * vnoise(x * fr + seed + o * 5.1) - 1);
    s += amp * n * n;
    norm += amp;
    amp *= 0.5;
    fr *= 2.15;
  }
  return s / norm;
}
// The height of a ridge line at its fraction t (0 to 1) along the arc.
function ridgeTop(L, t) {
  const a = MOUNT_ARC[0] + (MOUNT_ARC[1] - MOUNT_ARC[0]) * t;
  const massif = 0.3 + 0.7 * vnoise(a * 2.6 + L.p[0]); // which stretches stand high
  const peaks = 0.28 + 0.72 * ridged(a * 8 + L.p[1], L.p[1]);
  const env = Math.sin(Math.PI * t) ** 0.5; // the range tapers into the sea at both ends
  return L.h * Math.min(1, massif * peaks * 1.85) * env;
}

// The highest ridge in a direction seen from a point eyeY up (radians above the horizontal; -Infinity where there is none):
// (dx, dz) is the direction on the sea, x north and z east as in the scene. Used to hide what lies behind the mountains.
export function ridgeAngle(dx, dz, eyeY = 0) {
  let a = Math.atan2(dz, dx);
  if (a < MOUNT_ARC[0]) a += 2 * Math.PI;
  if (a > MOUNT_ARC[1]) return -Infinity;
  const t = (a - MOUNT_ARC[0]) / (MOUNT_ARC[1] - MOUNT_ARC[0]);
  let best = -Infinity;
  for (const L of MOUNT_LAYERS) best = Math.max(best, Math.atan2(ridgeTop(L, t) - eyeY, L.r));
  return best;
}

const ROW_F = [0, 0.28, 0.58, 0.82, 1]; // the rows of vertices between the foot (just under the sea) and the crest, as fractions of the height
const HAZE = [0.45, 0.62, 0.9]; // the colour the air turns the foot of a range to
function createMountains() {
  const A0 = MOUNT_ARC[0];
  const A1 = MOUNT_ARC[1];
  const pos = [];
  const col = [];
  const idx = [];
  const R = ROW_F.length;
  for (const L of MOUNT_LAYERS) {
    const base = pos.length / 3;
    for (let i = 0; i <= L.n; i++) {
      const t = i / L.n;
      const a = A0 + (A1 - A0) * t;
      const top = ridgeTop(L, t);
      // The slope of the crest here: the side facing the sun (toward smaller angles) is lit, the other in shade.
      const dt = 1 / L.n;
      const slope = (ridgeTop(L, Math.min(1, t + dt)) - ridgeTop(L, Math.max(0, t - dt))) / (2 * dt * (A1 - A0) * L.r);
      const lit = 0.88 + 0.24 * Math.min(1, Math.max(0, 0.5 + slope * 1.6));
      const x = Math.cos(a) * L.r;
      const z = Math.sin(a) * L.r;
      for (let k = 0; k < R; k++) {
        const f = ROW_F[k];
        pos.push(x, -40 + (top + 40) * f, z);
        const spur = 0.9 + 0.2 * vnoise(a * 55 + f * 7 + L.p[2]); // soft spurs running down the slopes
        const hz = Math.min(1, L.haze + 0.6 * (1 - f) ** 2.2);
        for (let c = 0; c < 3; c++) {
          let v = L.col[c] * lit * spur;
          v += (HAZE[c] - v) * hz;
          col.push(v);
        }
      }
    }
    for (let i = 0; i < L.n; i++) {
      for (let k = 0; k < R - 1; k++) {
        const p = base + i * R + k;
        const q = p + R;
        idx.push(p, q, p + 1, p + 1, q, q + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
  mesh.name = 'mountains';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1; // behind the sea and the ships
  return mesh;
}
