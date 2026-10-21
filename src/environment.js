import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mulberry32 } from './rng.js';
import { Kit } from './models/kit.js';

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
export function createEnvironment(renderer, scene, { calm = false, tallMountains = false } = {}) {
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
  const mountains = calm ? (tallMountains ? createTallMountains() : createMountains()) : null;
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

// Solo Air Defense only (`tallMountains`): a range of real terrain on the horizon, a heightfield seen from the sea. Ridged noise (warped,
// so the ridges bend and fork like real ones) gives peaks, spurs and valleys; the shore is irregular, with capes and bays, and the land
// rises from it in foothills to the high ranges behind. Each vertex is lit by the slope it is on (the sun from the left), coloured by
// height and steepness (green scrub low down, dry slopes, then bare rock higher up and wherever it is steep) and veiled in haze that
// thickens with distance and clears toward the tops. One mesh of about 90,000 vertices, no textures, no lights. Static, far enough
// that moving the camera barely shifts it. The ridge line that hides far drones (`ridgeAngle`) comes from the same heightfield.
const MOUNT_ARC = [-0.3, 3.4]; // radians: an arc of about 210 degrees
const T_COLS = 900;
const T_ROWS = 80;
const T_R0 = 4800; // m: the nearest the land comes (so the radar map's 6 km range reaches the shore)
const T_R1 = 17500; // m: the far edge of it
const T_H = 2100; // m: roughly the highest peaks
const hash2 = (ix, iz) => { // an integer hash, 0 to 1 (much cheaper than a sine, and this runs millions of times at start-up)
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
function vnoise2(x, z) { // smooth value noise, 0 to 1
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
function fbm(x, z, oct, gain = 0.5) {
  let s = 0;
  let amp = 0.5;
  let fr = 1;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    s += amp * vnoise2(x * fr + o * 17.3, z * fr - o * 9.1);
    norm += amp;
    amp *= gain;
    fr *= 2.03;
  }
  return s / norm;
}
function ridges(x, z, oct) { // sharp-crested ridges: 1 - |2n - 1|, squared, with each octave weighted by the one below it
  let s = 0;
  let amp = 0.5;
  let fr = 1;
  let w = 1;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    const n = 1 - Math.abs(2 * vnoise2(x * fr + o * 31.7, z * fr + o * 5.3) - 1);
    const v = n * n * w;
    s += amp * v;
    norm += amp;
    w = Math.min(1, Math.max(0.15, v * 1.6));
    amp *= 0.5;
    fr *= 2.07;
  }
  return s / norm;
}
const sstep = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
// The shore's distance from the ship at angle a, and the height of the land at (a, r) (below zero under the sea).
const endTaper = (a) => sstep(MOUNT_ARC[0], MOUNT_ARC[0] + 0.8, a) * sstep(MOUNT_ARC[1], MOUNT_ARC[1] - 0.8, a); // 0 at the ends of the arc, 1 along most of it
const CITY_A = 0.52; // the town's bearing (radians from north toward east): ahead and to starboard of a ship heading north
const coastR = (a) => T_R0 + 1500 * fbm(a * 3.2 + 4, 7.7, 3) + 700 * vnoise2(a * 11, 3.1) + 5500 * (1 - endTaper(a)) ** 1.5; // the shore draws back toward the ends
const CITY = (() => { const rc = coastR(CITY_A) + 900; return { a: CITY_A, x: Math.cos(CITY_A) * rc, z: Math.sin(CITY_A) * rc }; })(); // the town's middle, a little inland
function terrainH(a, r) {
  const x = Math.cos(a) * r * 0.00011;
  const z = Math.sin(a) * r * 0.00011;
  const wx = x + 0.55 * (fbm(x * 1.7 + 11, z * 1.7, 3) - 0.5); // the warp bends the ridges
  const wz = z + 0.55 * (fbm(x * 1.7, z * 1.7 + 23, 3) - 0.5);
  const massif = 0.28 + 0.72 * fbm(x * 0.55 + 3.3, z * 0.55 + 8.1, 3); // which parts stand high
  const crest = 0.18 + 0.82 * ridges(wx * 2.4, wz * 2.4, 6);
  const rough = 0.04 * (fbm(x * 9, z * 9, 3) - 0.5); // the small stuff
  const inland = sstep(0, 5200, r - coastR(a) - 500); // a clean beach first, then foothills, then the range
  const aEnds = endTaper(a);
  const outer = 1 - 0.55 * sstep(13500, T_R1, r);
  let h = T_H * massif * crest * inland * outer * aEnds ** 1.4 + T_H * rough * inland * aEnds + 12 * sstep(0, 1200, r - coastR(a)); // the 12 m is the beach: one clean rise out of the sea, no noise to flicker across the waterline
  const px = Math.cos(a) * r;
  const pz = Math.sin(a) * r;
  const plain = 1 - sstep(1000, 2400, Math.hypot(px - CITY.x, pz - CITY.z)); // the coastal plain the town stands on
  if (plain > 0) h += (10 + 2.5 * vnoise2(px * 0.004, pz * 0.004) - h) * plain;
  return h - 40 * (1 - sstep(0, 700, r - coastR(a))) - 6; // under the sea off the shore
}
let terrainMemo = null;
function terrain() {
  if (terrainMemo) return terrainMemo;
  const [A0, A1] = MOUNT_ARC;
  const rs = Array.from({ length: T_ROWS + 1 }, (_, j) => T_R0 - 600 + (T_R1 - T_R0 + 600) * (j / T_ROWS) ** 1.3);
  const heights = new Float32Array((T_COLS + 1) * (T_ROWS + 1));
  const sky = new Float32Array(T_COLS + 1); // the highest angle above the horizontal seen from the radar's height (15 m) in each direction
  for (let i = 0; i <= T_COLS; i++) {
    const a = A0 + ((A1 - A0) * i) / T_COLS;
    let best = -Infinity;
    for (let j = 0; j <= T_ROWS; j++) {
      const h = terrainH(a, rs[j]);
      heights[i * (T_ROWS + 1) + j] = h;
      best = Math.max(best, Math.atan2(h - 15, rs[j]));
    }
    for (let k = 1; k < 60; k++) { // the ridge between the rows can be higher than at them: a finer look along the line of sight
      const r = T_R0 + ((T_R1 - T_R0) * k) / 60;
      best = Math.max(best, Math.atan2(terrainH(a, r) - 15, r));
    }
    sky[i] = best;
  }
  terrainMemo = { rs, heights, sky };
  return terrainMemo;
}
// The highest ridge in a direction as seen from the radar (radians above the horizontal; -Infinity where there is no land): (dx, dz) is
// the direction on the sea, x north and z east as in the scene. Used to hide what lies behind the mountains.
// The height of the land at (dx, dz) metres from the ship, x north and z east (-1 over the sea), for the radar map.
export function landHeightAt(dx, dz) {
  let a = Math.atan2(dz, dx);
  if (a < MOUNT_ARC[0]) a += 2 * Math.PI;
  if (a > MOUNT_ARC[1]) return -1;
  return terrainH(a, Math.hypot(dx, dz));
}
export function ridgeAngle(dx, dz) {
  let a = Math.atan2(dz, dx);
  if (a < MOUNT_ARC[0]) a += 2 * Math.PI;
  if (a > MOUNT_ARC[1]) return -Infinity;
  const f = ((a - MOUNT_ARC[0]) / (MOUNT_ARC[1] - MOUNT_ARC[0])) * T_COLS;
  const i = Math.min(T_COLS - 1, Math.floor(f));
  const { sky } = terrain();
  const t = f - i;
  const v = sky[i] * (1 - t) + sky[i + 1] * t;
  return v < 0.0005 ? -Infinity : v;
}

const SUN = [-0.5, 0.62, 0.55]; // toward the sun, in the scene's x (north), y (up), z (east)
const HAZE = [0.6, 0.76, 0.93]; // the sky at the horizon, as it shows (sRGB)
// The towns: a coastal town on the flattened plain by the shore (a grid of lots with streets between, flats in the middle) that climbs the
// slope behind it in terraces, narrower houses laid along the contours and thinning with height, and two villages high on the
// mountainsides. White, cream and ochre walls, red-tile roofs; lit by the scene's sun like the ships (Lambert), their colours already
// veiled with a little haze. The layout is computed once (townLayout): the town mesh and the radar map's marks both come from it.
let townMemo = null;
function townLayout() {
  if (townMemo) return townMemo;
  const rng = mulberry32(77);
  const out = [];
  const ca = Math.cos(CITY.a);
  const sa = Math.sin(CITY.a);
  const at = (u, v) => [CITY.x + u * -sa + v * ca, CITY.z + u * ca + v * sa]; // u along the shore, v inland
  const hXZ = (x, z) => terrainH(Math.atan2(z, x), Math.hypot(x, z));
  const grad = (x, z) => [(hXZ(x + 30, z) - hXZ(x - 30, z)) / 60, (hXZ(x, z + 30) - hXZ(x, z - 30)) / 60];
  const rotY = -(CITY.a + Math.PI / 2);
  const place = (x, z, g, w, dp, hh, tall, roofed, slope, gx, gz) => {
    let yaw = rotY;
    if (slope > 0.12) yaw = Math.atan2(-gx, -gz); // laid along the contour: the box's long side across the fall line
    out.push({ x, z, g, w, dp, hh, tall, roofed, yaw, slope });
  };
  const lot = 84;
  // The town proper: the plain and the slope behind it.
  for (let iu = -16; iu <= 16; iu++) {
    for (let iv = -6; iv <= 40; iv++) {
      if (iu % 4 === 0 || iv % 5 === 0) continue; // the streets
      const u = iu * lot + (rng() - 0.5) * 12;
      const v = iv * lot + (rng() - 0.5) * 12;
      const [x, z] = at(u, v);
      const g = hXZ(x, z);
      if (g < 5) continue;
      const [gx, gz] = grad(x, z);
      const slope = Math.hypot(gx, gz);
      if (slope > 0.5) continue; // too steep to build on
      const dCore = Math.hypot(u, (v - 250) * 1.25) / 1250;
      const dist = Math.hypot(u, v - 250);
      const core = 0.92 * (1 - 0.85 * Math.min(1, dCore));
      const hill = 0.6 * (1 - sstep(40, 650, g)) * (1 - sstep(1200, 3600, dist)) * (1 - 0.6 * sstep(0.2, 0.5, slope));
      if (rng() > Math.max(dCore < 1 ? core : 0, hill)) continue;
      const tall = dCore < 0.28 && slope < 0.1 && rng() < 0.3;
      const onHill = slope > 0.1;
      const w = (onHill ? 30 : 38) + rng() * (onHill ? 20 : 34);
      const dp = (onHill ? 30 : 38) + rng() * (onHill ? 20 : 34);
      const hh = tall ? 55 + rng() * 55 : 16 + rng() * 14 * (1.2 - Math.min(1, dCore));
      place(x, z, g, w, dp, hh, tall, rng() < (onHill ? 0.75 : 0.5), slope, gx, gz);
    }
  }
  // Two villages high on the slopes: the flattest ground between 150 and 450 m up, 1.5 to 6 km behind the shore.
  for (const va of [1.55, 2.55]) {
    let best = null;
    for (let r = coastR(va) + 1500; r < coastR(va) + 6000; r += 120) {
      for (let da = -0.05; da <= 0.05; da += 0.01) {
        const x = Math.cos(va + da) * r;
        const z = Math.sin(va + da) * r;
        const g = hXZ(x, z);
        if (g < 150 || g > 450) continue;
        const [gx, gz] = grad(x, z);
        const s = Math.hypot(gx, gz);
        if (!best || s < best.s) best = { x, z, s };
      }
    }
    if (!best) continue;
    for (let i = 0; i < 90; i++) {
      const ang = rng() * Math.PI * 2;
      const rr = Math.sqrt(rng()) * 520;
      const x = best.x + Math.cos(ang) * rr;
      const z = best.z + Math.sin(ang) * rr;
      const g = hXZ(x, z);
      const [gx, gz] = grad(x, z);
      const slope = Math.hypot(gx, gz);
      if (g < 100 || slope > 0.45) continue;
      place(x, z, g, 30 + rng() * 22, 30 + rng() * 22, 14 + rng() * 12, false, rng() < 0.8, slope, gx, gz);
    }
  }
  townMemo = out;
  return out;
}
// Where the buildings are, metres from the ship (x north, z east) with their size, for the radar map.
export function townSpots() {
  return townLayout().map((b) => [b.x, b.z, Math.max(b.w, b.dp)]);
}
function createCity() {
  const hz = 0.16;
  const veil = (hex) => new THREE.Color(hex).lerp(new THREE.Color(0xa0c4ee), hz);
  const walls = [0xe8e2d6, 0xdcc9a3, 0xc9a46a, 0xd9b5a0, 0xb9c9d6, 0xe3d9c4].map((c) => new THREE.MeshLambertMaterial({ color: veil(c) }));
  const roofM = new THREE.MeshLambertMaterial({ color: veil(0xa5503a) });
  const flatM = new THREE.MeshLambertMaterial({ color: veil(0x8d8f90) });
  const pierM = new THREE.MeshLambertMaterial({ color: veil(0x55575a) });
  const whiteM = new THREE.MeshLambertMaterial({ color: veil(0xf4f1ea) });
  const rng = mulberry32(78);
  const k = new Kit();
  for (const b of townLayout()) {
    const sink = Math.min(1 + b.slope * Math.max(b.w, b.dp) * 0.5, b.hh * 0.4); // set into the slope: the uphill side buried
    const y = b.g - sink + b.hh / 2;
    k.add(new THREE.BoxGeometry(b.w, b.hh, b.dp), walls[Math.floor(rng() * walls.length)], { pos: [b.x, y, b.z], rot: [0, b.yaw, 0] });
    if (b.roofed) k.add(new THREE.BoxGeometry(b.w * 1.06, 5, b.dp * 1.06), roofM, { pos: [b.x, y + b.hh / 2 + 2, b.z], rot: [0, b.yaw, 0] });
    else k.add(new THREE.BoxGeometry(b.w * 0.96, 1.4, b.dp * 0.96), flatM, { pos: [b.x, y + b.hh / 2 + 0.6, b.z], rot: [0, b.yaw, 0] });
  }
  // The pier: out from the shore at u = 320, straight out to sea; and the lighthouse on the point at the town's end.
  const ca = Math.cos(CITY.a);
  const sa = Math.sin(CITY.a);
  const at = (u, v) => [CITY.x + u * -sa + v * ca, CITY.z + u * ca + v * sa];
  const hAt = (u, v) => { const [x, z] = at(u, v); return terrainH(Math.atan2(z, x), Math.hypot(x, z)); };
  const rotY = -(CITY.a + Math.PI / 2);
  let vs = -900;
  while (vs < 0 && hAt(320, vs) < 3) vs += 10;
  const [px, pz] = at(320, vs - 150);
  k.add(new THREE.BoxGeometry(16, 4, 420), pierM, { pos: [px, 3, pz], rot: [0, rotY + Math.PI, 0] });
  let ve = -900;
  while (ve < 0 && hAt(-1150, ve) < 3) ve += 10;
  const [lx, lz] = at(-1150, ve + 40);
  k.add(new THREE.CylinderGeometry(6, 9, 55, 12), whiteM, { pos: [lx, hAt(-1150, ve + 40) + 26, lz] });
  k.add(new THREE.CylinderGeometry(7, 7, 6, 12), pierM, { pos: [lx, hAt(-1150, ve + 40) + 58, lz] });
  const city = k.build({ name: 'city', castShadow: false, receiveShadow: false });
  city.traverse((o) => { o.frustumCulled = false; o.renderOrder = -1; });
  return city;
}

function createTallMountains() {
  const { rs, heights } = terrain();
  const [A0, A1] = MOUNT_ARC;
  const NR = T_ROWS + 1;
  const n = (T_COLS + 1) * NR;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i <= T_COLS; i++) {
    const a = A0 + ((A1 - A0) * i) / T_COLS;
    for (let j = 0; j < NR; j++) {
      const k = i * NR + j;
      pos[k * 3] = Math.cos(a) * rs[j];
      pos[k * 3 + 1] = heights[k];
      pos[k * 3 + 2] = Math.sin(a) * rs[j];
    }
  }
  const idx = new Uint32Array(T_COLS * T_ROWS * 6);
  let q = 0;
  for (let i = 0; i < T_COLS; i++) {
    for (let j = 0; j < T_ROWS; j++) {
      const p = i * NR + j;
      idx[q++] = p; idx[q++] = p + NR; idx[q++] = p + 1;
      idx[q++] = p + 1; idx[q++] = p + NR; idx[q++] = p + NR + 1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  const nor = geo.attributes.normal.array;
  const sl = Math.hypot(...SUN);
  const col = new Float32Array(n * 3);
  const mix = (a, b, t) => a + (b - a) * t;
  const GREEN = [0.2, 0.29, 0.15];
  const DRY = [0.45, 0.38, 0.27];
  const ROCK = [0.5, 0.47, 0.44];
  for (let k = 0; k < n; k++) {
    const h = pos[k * 3 + 1];
    const ny = nor[k * 3 + 1];
    const slope = 1 - ny;
    const d = Math.hypot(pos[k * 3], pos[k * 3 + 2]);
    const grain = 0.9 + 0.2 * vnoise2(pos[k * 3] * 0.006, pos[k * 3 + 2] * 0.006) + 0.08 * (vnoise2(pos[k * 3] * 0.03, pos[k * 3 + 2] * 0.03) - 0.5);
    const veg = (1 - sstep(250, 950, h)) * (1 - 0.85 * sstep(0.3, 0.6, slope));
    const rock = Math.min(1, 0.75 * sstep(0.4, 0.78, slope) + 0.55 * sstep(850, 1500, h));
    const dif = Math.max(0, (nor[k * 3] * SUN[0] + nor[k * 3 + 1] * SUN[1] + nor[k * 3 + 2] * SUN[2]) / sl);
    const shade = (0.3 + 0.92 * dif) * (0.86 + 0.24 * ny);
    const haze = Math.min(1, (1 - Math.exp(-((d / 21000) ** 1.2))) * (1 - 0.32 * sstep(0, 1400, h)));
    for (let c = 0; c < 3; c++) {
      let v = mix(mix(DRY[c], GREEN[c], veg), ROCK[c], rock) * grain * shade;
      v = mix(v, HAZE[c], haze);
      col[k * 3 + c] = Math.min(1, v) ** 2.2; // sRGB to the linear values the renderer expects
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false, side: THREE.DoubleSide }));
  mesh.name = 'mountains';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1; // behind the sea and the ships
  const group = new THREE.Group();
  group.name = 'mountains';
  group.add(mesh, createCity());
  return group;
}

// Distant mountains for the drill and the formations: three ridge lines on the horizon in an arc, each a strip of flat-coloured
// triangles (about 1,500 in all, one mesh, no textures, no lighting), paler the farther away so the air seems to thicken.
function createMountains() {
  const rng = mulberry32(31);
  const layers = [
    { r: 13000, h: 620, col: [0.5, 0.6, 0.72], n: 260 },
    { r: 10600, h: 470, col: [0.34, 0.45, 0.58], n: 260 },
    { r: 8800, h: 330, col: [0.2, 0.3, 0.42], n: 260 },
  ];
  const A0 = -0.3;
  const A1 = 3.4; // radians: an arc of about 210 degrees
  const pos = [];
  const col = [];
  const idx = [];
  for (const L of layers) {
    const p = [rng() * 6.28, rng() * 6.28, rng() * 6.28];
    const base = pos.length / 3;
    for (let i = 0; i <= L.n; i++) {
      const t = i / L.n;
      const a = A0 + (A1 - A0) * t;
      const n = 0.5 * Math.sin(a * 7 + p[0]) + 0.3 * Math.sin(a * 17 + p[1]) + 0.2 * Math.sin(a * 41 + p[2]);
      const env = Math.sin(Math.PI * t) ** 0.6; // the range tapers into the sea at both ends
      const top = L.h * (0.3 + 0.7 * (0.5 + 0.5 * n)) * env;
      const x = Math.cos(a) * L.r;
      const z = Math.sin(a) * L.r;
      pos.push(x, -40, z, x, top, z);
      col.push(L.col[0] * 0.8, L.col[1] * 0.8, L.col[2] * 0.85, L.col[0] * 1.1, L.col[1] * 1.1, L.col[2] * 1.08);
    }
    for (let i = 0; i < L.n; i++) {
      const k = base + i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
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
