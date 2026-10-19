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
  if (calm) scene.add(createMountains());
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
      ocean.position.x = camPos.x;
      ocean.position.z = camPos.z;
      for (const c of clouds.children) {
        const b = c.userData.base;
        c.position.x = b.x + Math.round((camPos.x - b.x) / CLOUD_PERIOD) * CLOUD_PERIOD;
        c.position.z = b.z + Math.round((camPos.z - b.z) / CLOUD_PERIOD) * CLOUD_PERIOD;
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

// Analytic ocean, kept deliberately simple so the frame rate stays high: a handful of deep-water waves
// evaluated per fragment for the normal only (the surface itself stays flat), a sky gradient reflected by
// Fresnel, the sun's glitter, and a cheap wake. No noise textures, no environment lookups. Driven by scene
// time, so it rewinds with the timeline.
const WAVE_COUNT = 6;

function waveSet() {
  const rng = mulberry32(4242);
  const wind = Math.atan2(0.6, 0.8);
  const dirs = [];
  const wl = [];
  const amp = [];
  const phase = [];
  for (let i = 0; i < WAVE_COUNT; i++) {
    // Long swells stay close to the wind; short chop spreads wider.
    const spread = 0.35 + 0.9 * (i / WAVE_COUNT);
    const a = wind + (rng() * 2 - 1) * spread;
    dirs.push(new THREE.Vector2(Math.cos(a), Math.sin(a)));
    const L = 95 * 0.55 ** i * (0.85 + 0.3 * rng()); // about 95, 52, 29, 16, 9 and 5 m
    wl.push(L);
    amp.push(((0.07 + 0.03 * rng()) * L) / (2 * Math.PI)); // steepness a·k ≈ 0.07–0.10
    phase.push(rng() * Math.PI * 2);
  }
  return { dirs, wl, amp, phase };
}

function createOcean(sunDir, calm, horizon) {
  const waves = waveSet();
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
      uDirs: { value: waves.dirs },
      uWl: { value: waves.wl },
      uAmp: { value: waves.amp },
      uPhase: { value: waves.phase },
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
      #define NW ${WAVE_COUNT}
      uniform float uTime;
      uniform vec3 uSunDir, uSunColor, uDeep, uScatter, uHorizon, uZenith;
      uniform float uFogNear, uFogFar, uShipX, uCalm, uGrid, uGridCell;
      uniform vec2 uRingC;
      uniform vec2 uDirs[NW];
      uniform float uWl[NW], uAmp[NW], uPhase[NW];
      varying vec3 vWorld;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
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
        vec2 grad = vec2(0.0);
        for (int i = 0; i < NW; i++) {
          float k = 6.2831853 / uWl[i];
          float w = sqrt(9.81 * k);
          // Fade each wave before it aliases (shorter waves fade sooner).
          float fade = 1.0 - smoothstep(uWl[i] * mix(12.0, 6.0, uCalm), uWl[i] * mix(60.0, 30.0, uCalm), dist);
          float ph = dot(uDirs[i], vWorld.xz) * k - w * uTime + uPhase[i];
          grad += uDirs[i] * (uAmp[i] * mix(1.0, 0.6, uCalm) * k * cos(ph) * fade);
        }
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
        vec3 spec = uSunColor * (pow(sunDot, 700.0) * 5.0 + pow(sunDot, 70.0) * 0.12) * mix(1.0, 0.4, uCalm);
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
    sprite.position.set(Math.cos(a) * d, (calm ? 450 : 900) + rng() * (calm ? 1700 : 1400), Math.sin(a) * d);
    sprite.userData.base = sprite.position.clone();
    sprite.scale.set(size, size * 0.5, 1);
    group.add(sprite);
  }
  return group;
}

// Distant mountains for the drill: three ridge lines on the horizon in an arc, each a strip of flat-coloured
// triangles (about 1,500 in all, one mesh, no textures, no lighting), paler the farther away so the air seems to
// thicken. Static, far enough that moving the camera barely shifts them.
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
