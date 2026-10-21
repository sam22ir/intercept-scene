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
// The towns: a coastal town on the flattened plain by the shore, built on a street grid with a slow bend (tree-lined avenues, blocks of
// flats in the middle with a few towers in the core, small houses with red-tile roofs thinning out toward the hills, a ground that
// is paved and grey under it: see townGround), a harbour with a quay, sheds, containers, gantry cranes and a breakwater, a pier and a
// lighthouse; the same houses climb the slope behind in terraces, laid along the contours, and two villages stand high on the
// mountainsides. The walls are plaster in muted creams, sands and ochres with rows of windows (a small canvas texture), the roofs
// tile or tar, the trees dark green bicones. All of it is lit like the mountains (baked per vertex from the same sun, darker at the
// foot of each wall, the same haze with distance) so it sits in the landscape instead of glowing against it. The layout is computed
// once (townLayout): the town mesh and the radar map's marks both come from it.
const LOT = 46; // m: one cell of the town's grid (a building and its share of the street)
const AVE_U = 5; // every fifth column of cells is an avenue
const AVE_V = 6; // and every sixth row
const CA = Math.cos(CITY.a);
const SA = Math.sin(CITY.a);
const townAt = (u, v) => { // u along the shore, v inland, bent a little so the streets are not ruled lines
  const wu = u + 24 * (vnoise2(v * 0.0045 + 7, u * 0.0045) - 0.5);
  const wv = v + 24 * (vnoise2(u * 0.0045, v * 0.0045 + 13) - 0.5);
  return [CITY.x + wu * -SA + wv * CA, CITY.z + wu * CA + wv * SA];
};
const coreD = (u, v) => Math.hypot(u, (v - 300) * 1.1) / 1500; // 1 at the edge of the built-up plain
// How built up the ground is at (x, z) (0 to 1) and how close it lies to an avenue (0 to 1), for the terrain's colours.
function townGround(x, z) {
  const dx = x - CITY.x;
  const dz = z - CITY.z;
  const u = -dx * SA + dz * CA;
  const v = dx * CA + dz * SA;
  const built = Math.min(1, (1 - sstep(0.65, 1.2, coreD(u, v))) * (0.75 + 0.5 * vnoise2(x * 0.012, z * 0.012)));
  if (built <= 0) return [0, 0];
  const du = Math.abs(u - LOT * AVE_U * Math.round(u / (LOT * AVE_U)));
  const dv = Math.abs(v - LOT * AVE_V * Math.round(v / (LOT * AVE_V)));
  return [built, built * (1 - sstep(5, 20, Math.min(du, dv)))];
}
const WALLS = [[0.92, 0.89, 0.82], [0.88, 0.8, 0.66], [0.82, 0.68, 0.5], [0.88, 0.72, 0.64], [0.8, 0.82, 0.82], [0.94, 0.93, 0.9], [0.72, 0.76, 0.8], [0.84, 0.76, 0.58]];
const TILES = [[0.66, 0.31, 0.21], [0.58, 0.27, 0.19], [0.72, 0.39, 0.27], [0.62, 0.34, 0.24]];
const FLATS = [[0.52, 0.52, 0.5], [0.4, 0.4, 0.42], [0.68, 0.66, 0.6], [0.46, 0.44, 0.42]];
const GLASS = [[0.45, 0.58, 0.7], [0.58, 0.65, 0.7], [0.36, 0.45, 0.55], [0.7, 0.75, 0.78]];
const LEAF = [[0.17, 0.3, 0.14], [0.2, 0.33, 0.15], [0.14, 0.25, 0.13], [0.24, 0.34, 0.16]];
const BOXES = [[0.7, 0.2, 0.15], [0.15, 0.35, 0.6], [0.85, 0.65, 0.15], [0.2, 0.5, 0.3], [0.78, 0.78, 0.76], [0.55, 0.2, 0.2]];
let townMemo = null;
function townLayout() {
  if (townMemo) return townMemo;
  const rng = mulberry32(77);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const tint = (c, k = 0.06) => { const f = 1 + (rng() - 0.5) * 2 * k; return [c[0] * f, c[1] * f, c[2] * f]; };
  const buildings = []; // the textured ones (and the sheds), also the radar map's marks
  const props = []; // plain boxes: quay, containers, cranes, breakwater, the lighthouse
  const trees = [];
  const rotY = -(CITY.a + Math.PI / 2);
  const hXZ = (x, z) => terrainH(Math.atan2(z, x), Math.hypot(x, z));
  const grad = (x, z) => [(hXZ(x + 30, z) - hXZ(x - 30, z)) / 60, (hXZ(x, z + 30) - hXZ(x, z - 30)) / 60];
  const shoreV = (u) => { let v = -900; while (v < 0 && hXZ(...townAt(u, v)) < 3) v += 10; return v; }; // where the land begins, going inland
  const addTree = (x, z, big = 1) => {
    const g = hXZ(x, z);
    if (g < 3) return;
    const cyp = rng() < 0.12;
    trees.push({ x, z, g, h: (cyp ? 11 : 6.5) * big + rng() * 5, r: (cyp ? 1.5 : 2.8 + rng() * 2.2) * big, c: tint(pick(LEAF), 0.12) });
  };
  const addHouse = (x, z, g, w, dp, hh, yaw, slope, roof) => {
    const sink = Math.min(1.5 + slope * Math.max(w, dp) * 0.5, hh * 0.4);
    buildings.push({ kind: 'house', x, z, y0: g - sink, w, dp, hh, yaw, c: tint(pick(WALLS)), rc: tint(pick(roof === 'flat' ? FLATS : TILES)), roof });
  };
  const PORT_U0 = 440;
  const PORT_U1 = 1000;
  const portSV = shoreV((PORT_U0 + PORT_U1) / 2);
  const inPort = (u, v) => u > PORT_U0 - 40 && u < PORT_U1 + 40 && v < portSV + 270;
  // The town proper: the plain and the slope behind it.
  for (let iu = -30; iu <= 30; iu++) {
    for (let iv = -10; iv <= 80; iv++) {
      const u0 = iu * LOT;
      const v0 = iv * LOT;
      const dCore = coreD(u0, v0);
      if (iu % AVE_U === 0 || iv % AVE_V === 0) { // an avenue: a line of trees down each side
        if (dCore < 1.05) {
          for (const s of [-1, 1]) {
            for (const q of [-0.25, 0.25]) {
              if (rng() < 0.85) addTree(...townAt(iu % AVE_U === 0 ? u0 + s * 14 : u0 + q * LOT, iu % AVE_U === 0 ? v0 + q * LOT : v0 + s * 14), 0.9);
            }
          }
        }
        continue;
      }
      if (inPort(u0, v0)) continue;
      const dist = Math.hypot(u0, v0 - 300);
      const [x, z] = townAt(u0 + (rng() - 0.5) * 6, v0 + (rng() - 0.5) * 6);
      const g = hXZ(x, z);
      if (g < 3.2) continue;
      const hill = 0.5 * (1 - sstep(40, 650, g)) * (1 - sstep(1200, 3600, dist));
      const dens = Math.max(dCore < 1 ? 0.97 * (1 - 0.72 * Math.min(1, dCore)) : 0, hill);
      if (rng() > dens) { // an empty lot: a garden, a few trees
        if (dCore < 0.95 && rng() < 0.55) addTree(...townAt(u0 + (rng() - 0.5) * 20, v0 + (rng() - 0.5) * 20));
        continue;
      }
      const [gx, gz] = grad(x, z);
      const slope = Math.hypot(gx, gz);
      if (slope > 0.5 || rng() < 0.6 * sstep(0.2, 0.5, slope)) continue; // too steep to build on
      const onHill = slope > 0.1;
      const yaw = onHill ? Math.atan2(-gx, -gz) : rotY; // on a slope the box's long side lies across the fall line
      const sink = Math.min(1.5 + slope * 20, 12);
      if (onHill) { // terraces of small houses along the contour
        const n = 1 + (rng() < 0.45 ? 1 : 0);
        for (let i = 0; i < n; i++) {
          const hx = x + (rng() - 0.5) * 30;
          const hz = z + (rng() - 0.5) * 30;
          const hg = hXZ(hx, hz);
          if (hg < 3.2) continue;
          addHouse(hx, hz, hg, 11 + rng() * 8, 10 + rng() * 6, 6 + rng() * 3, yaw, slope, 'gable');
          if (rng() < 0.4) addTree(hx + (rng() - 0.5) * 24, hz + (rng() - 0.5) * 24);
        }
        continue;
      }
      const zone = dCore < 0.3 ? 0 : dCore < 0.7 ? 1 : 2;
      if (zone === 0 && rng() < 0.22) { // a tower in the core
        const w = 24 + rng() * 10;
        const dp = 22 + rng() * 10;
        const hh = 42 + rng() * 58 * Math.max(0.3, 1 - dCore * 2.5);
        buildings.push({ kind: 'tower', x, z, y0: g - sink, w, dp, hh, yaw, c: tint(pick(GLASS)), rc: tint(pick(FLATS)), roof: 'flat' });
      } else if (zone < 2 && rng() < 0.78) { // a block of flats
        const w = 26 + rng() * 14;
        const dp = 22 + rng() * 15;
        const floors = (zone === 0 ? 5 : 3) + Math.floor(rng() * (zone === 0 ? 5 : 4));
        buildings.push({ kind: 'block', x, z, y0: g - sink, w, dp, hh: floors * 3.1, yaw, c: tint(pick(WALLS)), rc: tint(pick(FLATS)), roof: rng() < 0.2 ? 'gable' : 'flat' });
      } else if (zone === 2 && rng() < 0.2) { // low block at the edge
        const w = 22 + rng() * 12;
        const dp = 18 + rng() * 12;
        buildings.push({ kind: 'block', x, z, y0: g - sink, w, dp, hh: (2 + Math.floor(rng() * 3)) * 3.1, yaw, c: tint(pick(WALLS)), rc: tint(pick(TILES)), roof: 'gable' });
      } else { // up to four houses in the lot
        for (const [su, sv] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
          if (rng() > (zone === 2 ? 0.78 : 0.55)) continue;
          const [hx, hz] = townAt(u0 + su * LOT + (rng() - 0.5) * 3, v0 + sv * LOT + (rng() - 0.5) * 3);
          const hg = hXZ(hx, hz);
          if (hg < 3.2) continue;
          addHouse(hx, hz, hg, 11 + rng() * 6, 10 + rng() * 5, 6 + rng() * 3.5, yaw, slope, rng() < 0.82 ? 'gable' : 'flat');
          if (rng() < 0.3) addTree(hx + (rng() - 0.5) * 18, hz + (rng() - 0.5) * 18);
        }
      }
    }
  }
  // The harbour: a quay along the shore with sheds behind it, rows of containers, three gantry cranes and a breakwater.
  const QUAY = 4.8;
  const slab = (u, v, w, d, y0, h, c) => { const [x, z] = townAt(u, v); props.push({ x, z, y0, w, d, h, yaw: rotY, c }); };
  for (let u = PORT_U0; u < PORT_U1; u += 40) {
    const sv = shoreV(u + 20);
    slab(u + 20, sv + 17, 41, 46, -20, QUAY + 20, [0.6, 0.58, 0.54]);
    for (let r = 0; r < 5; r++) { // the container stacks (a few lots left empty for the lorries)
      if (rng() < 0.3) continue;
      const stack = 1 + Math.floor(rng() * 3);
      const c = tint(pick(BOXES), 0.1);
      for (let k = 0; k < stack; k++) slab(u + 20 + (rng() - 0.5) * 3, sv + 18 + r * 3.3, 12.2, 2.6, QUAY + k * 2.6, 2.6, c);
    }
    if ((u - PORT_U0) % 80 === 0) {
      for (const row of [66, 112]) {
        const [x, z] = townAt(u + 20, shoreV(u + 20) + row);
        const g = hXZ(x, z);
        buildings.push({ kind: 'shed', x, z, y0: g - 1.5, w: 62, dp: 28, hh: 9 + rng() * 3, yaw: rotY, c: tint(rng() < 0.5 ? [0.78, 0.8, 0.82] : [0.84, 0.82, 0.74]), rc: tint([0.45, 0.5, 0.55]), roof: 'gable', plain: true });
      }
    }
  }
  for (const cu of [520, 680, 840]) { // the gantry cranes: four legs, a boom out over the water and a house on it
    const sv = shoreV(cu);
    const red = [0.78, 0.3, 0.2];
    for (const du of [-8, 8]) {
      for (const dv of [4, 18]) slab(cu + du, sv + dv, 1.8, 1.8, QUAY, 28, red);
      slab(cu + du, sv - 8, 1.6, 66, QUAY + 28, 2.4, red); // the boom over the ship
    }
    for (const dv of [4, 18]) slab(cu, sv + dv, 18, 1.8, QUAY + 28, 1.8, red);
    slab(cu, sv + 11, 7, 6, QUAY + 30.4, 5, [0.85, 0.85, 0.82]);
    slab(cu, sv - 20, 3, 3, QUAY + 25.4, 2.4, [0.3, 0.3, 0.32]);
  }
  const bu = PORT_U1 + 60; // the breakwater: out to sea, then along the harbour
  const bsv = shoreV(bu);
  slab(bu, bsv - 140, 14, 330, -20, 25, [0.5, 0.49, 0.47]);
  slab(bu - 140, bsv - 296, 300, 14, -20, 25, [0.5, 0.49, 0.47]);
  // The pier out from the shore at u = 320, straight out to sea; and the lighthouse on the point at the town's end.
  const psv = shoreV(320);
  slab(320, psv - 150, 16, 420, 1, 4, [0.4, 0.4, 0.42]);
  const lsv = shoreV(-1150) + 40;
  const [lx, lz] = townAt(-1150, lsv);
  const lg = hXZ(lx, lz);
  props.push({ shape: 'cone', x: lx, z: lz, y0: lg - 2, h: 56, r0: 9, r1: 6, c: [0.95, 0.94, 0.9] });
  props.push({ shape: 'cone', x: lx, z: lz, y0: lg + 54, h: 6, r0: 7, r1: 7, c: [0.35, 0.35, 0.38] });
  props.push({ shape: 'cone', x: lx, z: lz, y0: lg + 60, h: 4, r0: 7, r1: 0.5, c: [0.55, 0.2, 0.18] });
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
    for (let i = 0; i < 110; i++) {
      const ang = rng() * Math.PI * 2;
      const rr = Math.sqrt(rng()) * 520;
      const x = best.x + Math.cos(ang) * rr;
      const z = best.z + Math.sin(ang) * rr;
      const g = hXZ(x, z);
      const [gx, gz] = grad(x, z);
      const slope = Math.hypot(gx, gz);
      if (g < 100 || slope > 0.45) continue;
      addHouse(x, z, g, 12 + rng() * 9, 11 + rng() * 7, 6 + rng() * 4, slope > 0.12 ? Math.atan2(-gx, -gz) : rng() * Math.PI, slope, 'gable');
      if (rng() < 0.35) addTree(x + (rng() - 0.5) * 26, z + (rng() - 0.5) * 26);
    }
  }
  townMemo = { buildings, props, trees };
  return townMemo;
}
// Where the buildings are, metres from the ship (x north, z east) with their size, for the radar map.
export function townSpots() {
  return townLayout().buildings.map((b) => [b.x, b.z, Math.max(b.w, b.dp)]);
}
// A tile of one floor of plain wall with a window, repeated up and across the walls (the vertex colours tint it).
function windowTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#e6e6e6'; // a shade of lintel above and sill below
  g.fillRect(16, 8, 32, 4);
  g.fillRect(16, 48, 32, 3);
  const glass = g.createLinearGradient(0, 12, 0, 48);
  glass.addColorStop(0, '#61778e');
  glass.addColorStop(1, '#2e3a48');
  g.fillStyle = glass;
  g.fillRect(20, 12, 24, 36);
  g.fillStyle = '#c8c8c8'; // the frame's middle bar
  g.fillRect(31, 12, 2, 36);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function createCity() {
  const { buildings, props, trees } = townLayout();
  const sl = Math.hypot(...SUN);
  const mix = (a, b, t) => a + (b - a) * t;
  const walls = { pos: [], col: [], uv: [], idx: [], tex: true }; // wall quads carry the window texture
  const solid = { pos: [], col: [], uv: [], idx: [], tex: false }; // everything else is one flat colour a face
  // One vertex: lit by the mountains' sun, darkened by `ao`, veiled with the same haze by distance, in linear light.
  const vert = (m, p, c, n, ao, u, v) => {
    const dif = Math.max(0, (n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2]) / sl);
    const shade = (0.4 + 0.82 * dif) * ao;
    const haze = Math.min(1, (1 - Math.exp(-((Math.hypot(p[0], p[2]) / 21000) ** 1.2))) * (1 - 0.32 * sstep(0, 1400, p[1])));
    for (let k = 0; k < 3; k++) m.col.push(Math.min(1, mix(Math.min(1, c[k] * shade), HAZE[k], haze)) ** 2.2);
    m.pos.push(p[0], p[1], p[2]);
    m.uv.push(u, v);
  };
  const face = (m, pts, c, n, aos, uvs) => { // a convex polygon, `n` its outward normal
    const i0 = m.pos.length / 3;
    for (let i = 0; i < pts.length; i++) vert(m, pts[i], c, n, aos ? aos[i] : 1, uvs ? uvs[i][0] : 0, uvs ? uvs[i][1] : 0);
    for (let i = 1; i < pts.length - 1; i++) m.idx.push(i0, i0 + i, i0 + i + 1);
  };
  const unit = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  // A box: walls, a flat roof (unless `roof` is 'gable', then a pitched one over the longer side) and, for gables, the end triangles.
  const box = (m, b, c, rc, roof, floor = 3.1) => {
    const cy = Math.cos(b.yaw);
    const sy = Math.sin(b.yaw);
    const P = (lx, y, lz) => [b.x + lx * cy + lz * sy, y, b.z - lx * sy + lz * cy];
    const N = (lx, ly, lz) => unit([lx * cy + lz * sy, ly, -lx * sy + lz * cy]);
    const y0 = b.y0;
    const y1 = y0 + b.hh;
    const hw = b.w / 2;
    const hd = b.dp / 2;
    const yAo = y0 + Math.min(8, b.hh * 0.5); // the dark foot of each wall
    const rows = [[y0, 0.62], [yAo, 1], [y1, 1]];
    const sides = [[[hw, -hd], [hw, hd], [1, 0], b.dp], [[-hw, hd], [-hw, -hd], [-1, 0], b.dp], [[hw, hd], [-hw, hd], [0, 1], b.w], [[-hw, -hd], [hw, -hd], [0, -1], b.w]];
    for (const [A, B, n, wd] of sides) {
      for (let r = 0; r < 2; r++) {
        const [ya, aa] = rows[r];
        const [yb, ab] = rows[r + 1];
        if (yb - ya < 0.01) continue;
        face(m, [P(A[0], ya, A[1]), P(B[0], ya, B[1]), P(B[0], yb, B[1]), P(A[0], yb, A[1])], c, N(n[0], 0, n[1]), [aa, aa, ab, ab],
          [[0, (ya - y0) / floor], [wd / 3.6, (ya - y0) / floor], [wd / 3.6, (yb - y0) / floor], [0, (yb - y0) / floor]]);
      }
    }
    if (roof === 'gable') {
      const ov = 0.7;
      const rh = Math.min(b.w, b.dp) * 0.3 + 0.8;
      const along = b.w >= b.dp; // the ridge runs along the longer side
      const [L, S] = along ? [hw + ov, hd + ov] : [hd + ov, hw + ov];
      const at = (a, h, s) => (along ? P(a, y1 + h, s) : P(s, y1 + h, a)); // a along the ridge, s across it
      const nr = (s) => (along ? N(0, S, s * rh) : N(s * rh, S, 0));
      for (const s of [-1, 1]) {
        face(solid, [at(-L, 0, s * S), at(L, 0, s * S), at(L, rh, 0), at(-L, rh, 0)], rc, nr(s));
      }
      for (const e of [-1, 1]) {
        const E = along ? hw : hd;
        const Sh = along ? hd : hw;
        face(solid, [at(e * E, 0, -Sh), at(e * E, 0, Sh), at(e * E, rh * 0.85, 0)], c, along ? N(e, 0, 0) : N(0, 0, e), [0.9, 0.9, 1]);
      }
    } else {
      face(solid, [P(-hw, y1, -hd), P(hw, y1, -hd), P(hw, y1, hd), P(-hw, y1, hd)], rc, [0, 1, 0]);
    }
  };
  const plain = (b) => { // a solid-coloured box, the same shape of walls and roof
    box(solid, { x: b.x, z: b.z, y0: b.y0, hh: b.h, w: b.w, dp: b.d, yaw: b.yaw }, b.c, b.c, 'flat');
  };
  const cone = (b) => { // a round tower: n sides, a radius at the foot and at the top
    const n = 10;
    const y1 = b.y0 + b.h;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const am = (a0 + a1) / 2;
      const q = (a, r, y) => [b.x + Math.cos(a) * r, y, b.z + Math.sin(a) * r];
      face(solid, [q(a0, b.r0, b.y0), q(a1, b.r0, b.y0), q(a1, b.r1, y1), q(a0, b.r1, y1)], b.c, unit([Math.cos(am), 0.1, Math.sin(am)]), [0.7, 0.7, 1, 1]);
    }
    if (b.r1 > 1) face(solid, Array.from({ length: n }, (_, i) => [b.x + Math.cos((i / n) * Math.PI * 2) * b.r1, y1, b.z + Math.sin((i / n) * Math.PI * 2) * b.r1]), b.c, [0, 1, 0]);
  };
  for (const b of buildings) {
    if (b.kind === 'tower') {
      box(walls, b, b.c, b.rc, 'flat', 3.6);
      const top = b.y0 + b.hh; // a smaller crown and an aerial
      plain({ x: b.x, z: b.z, y0: top, h: 6, w: b.w * 0.55, d: b.dp * 0.55, yaw: b.yaw, c: [b.rc[0] * 0.9, b.rc[1] * 0.9, b.rc[2] * 0.9] });
      plain({ x: b.x, z: b.z, y0: top + 6, h: 14, w: 0.8, d: 0.8, yaw: b.yaw, c: [0.5, 0.5, 0.52] });
    } else if (b.plain) {
      box(solid, b, b.c, b.rc, b.roof);
    } else {
      box(walls, b, b.c, b.rc, b.roof, b.kind === 'house' ? 3 : 3.1);
      if (b.kind === 'block' && b.roof === 'flat') { // the stair head and the air handling
        const top = b.y0 + b.hh;
        plain({ x: b.x + b.w * 0.15, z: b.z, y0: top, h: 2.6, w: 5, d: 5, yaw: b.yaw, c: [b.rc[0] * 1.15, b.rc[1] * 1.15, b.rc[2] * 1.15] });
      }
    }
  }
  for (const p of props) (p.shape === 'cone' ? cone : plain)(p);
  for (const t of trees) { // a bicone: the foliage widest low down, the trunk hidden beneath
    const n = 5;
    const rot = (t.x * 7.3 + t.z * 3.1) % 6.28;
    const eq = Array.from({ length: n }, (_, i) => [t.x + Math.cos(rot + (i / n) * Math.PI * 2) * t.r, t.g + t.h * 0.42, t.z + Math.sin(rot + (i / n) * Math.PI * 2) * t.r]);
    const lo = [t.x, t.g + t.h * 0.12, t.z];
    const hi = [t.x, t.g + t.h, t.z];
    const mid = [t.x, t.g + t.h * 0.5, t.z];
    for (let i = 0; i < n; i++) {
      const a = eq[i];
      const b = eq[(i + 1) % n];
      for (const [apex, ao] of [[lo, 0.55], [hi, 1]]) {
        const nn = unit([(a[0] + b[0]) / 2 - mid[0], apex === hi ? 0.8 : -0.5, (a[2] + b[2]) / 2 - mid[2]]);
        face(solid, [a, b, apex], t.c, nn, [0.85, 0.85, ao]);
      }
    }
  }
  const mesh = (m, map) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(m.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uv, 2));
    g.setIndex(m.idx);
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, map, fog: false, toneMapped: false, side: THREE.DoubleSide }));
  };
  const city = new THREE.Group();
  city.name = 'city';
  city.add(mesh(walls, windowTexture()), mesh(solid, null));
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
  const URBAN = [0.5, 0.47, 0.42]; // the ground under the town: paving, yards and bare earth
  const ASPHALT = [0.34, 0.34, 0.35];
  const SAND = [0.8, 0.72, 0.54]; // the beach along every shore
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
    const sand = sstep(-6, 0.5, h) * (1 - sstep(1.5, 4.2, h));
    const [built, street] = townGround(pos[k * 3], pos[k * 3 + 2]);
    for (let c = 0; c < 3; c++) {
      let v = mix(mix(DRY[c], GREEN[c], veg), ROCK[c], rock);
      v = mix(v, SAND[c], sand);
      v = mix(v, URBAN[c], 0.85 * built);
      v = mix(v, ASPHALT[c], 0.8 * street);
      v *= grain * shade;
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
