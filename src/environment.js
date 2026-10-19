import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mulberry32 } from './rng.js';

const SUN_ELEVATION = 24; // degrees
const SUN_AZIMUTH = 215;
const HORIZON = new THREE.Color(0.66, 0.74, 0.84);
const ZENITH = new THREE.Color(0.2, 0.38, 0.66);

export function createEnvironment(renderer, scene) {
  const sunDir = new THREE.Vector3().setFromSphericalCoords(
    1, THREE.MathUtils.degToRad(90 - SUN_ELEVATION), THREE.MathUtils.degToRad(SUN_AZIMUTH),
  );

  const sky = new Sky();
  sky.scale.setScalar(20000);
  const u = sky.material.uniforms;
  u.turbidity.value = 5;
  u.rayleigh.value = 1.4;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.82;
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);

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

  scene.fog = new THREE.Fog(HORIZON, 3000, 16000);

  const sun = new THREE.DirectionalLight(0xfff1dc, 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.4;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x203040, 0.6));

  const ocean = createOcean(sunDir);
  scene.add(ocean);
  const clouds = createClouds();
  scene.add(clouds);
  const CLOUD_PERIOD = 26000; // the cloud field repeats this often, so it never runs out under a far-flying camera

  return {
    sunDir,
    ocean,
    // For a camera that travels far from the origin (the manual-flight mission): the sky dome and the WebGL
    // sea plane ride along with it, and the clouds wrap around it, so the world never ends.
    follow(camPos) {
      sky.position.set(camPos.x, 0, camPos.z);
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

function createOcean(sunDir) {
  const waves = waveSet();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color(1.0, 0.93, 0.8) },
      uDeep: { value: new THREE.Color(0.006, 0.045, 0.085) },
      uScatter: { value: new THREE.Color(0.02, 0.13, 0.16) },
      uHorizon: { value: HORIZON },
      uZenith: { value: ZENITH },
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
      uniform float uFogNear, uFogFar, uShipX;
      uniform vec2 uDirs[NW];
      uniform float uWl[NW], uAmp[NW], uPhase[NW];
      varying vec3 vWorld;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
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
          float fade = 1.0 - smoothstep(uWl[i] * 12.0, uWl[i] * 60.0, dist);
          float ph = dot(uDirs[i], vWorld.xz) * k - w * uTime + uPhase[i];
          grad += uDirs[i] * (uAmp[i] * k * cos(ph) * fade);
        }
        vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
        // Distant water flattens toward a smooth average normal.
        n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(800.0, 6000.0, dist) * 0.6));
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
        vec3 spec = uSunColor * (pow(sunDot, 700.0) * 5.0 + pow(sunDot, 70.0) * 0.12);
        vec3 col = mix(water, sky, fresnel * 0.9) + spec;
        float foam = wakeFoam(vWorld.xz, dist);
        vec3 foamCol = vec3(0.82, 0.87, 0.9) * (0.55 + 0.45 * max(uSunDir.y, 0.0));
        col = mix(col, foamCol, foam);
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
function createClouds() {
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
      const shade = 225 + r() * 30;
      g.addColorStop(0, `rgba(${shade},${shade},${shade + 3},0.5)`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
  const group = new THREE.Group();
  for (let i = 0; i < 38; i++) {
    const a = rng() * Math.PI * 2;
    const d = 2500 + rng() * 9000;
    const size = 700 + rng() * 1300;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: textures[i % 3], transparent: true, depthWrite: false, fog: false, opacity: 0.75 + rng() * 0.25,
      color: new THREE.Color(2.3, 2.3, 2.4), // above 1 so tone mapping keeps them as bright as the sky
    }));
    sprite.position.set(Math.cos(a) * d, 900 + rng() * 1400, Math.sin(a) * d);
    sprite.userData.base = sprite.position.clone();
    sprite.scale.set(size, size * 0.5, 1);
    group.add(sprite);
  }
  return group;
}
