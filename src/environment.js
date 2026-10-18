import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mulberry32 } from './rng.js';

const SUN_ELEVATION = 24; // degrees
const SUN_AZIMUTH = 215;
const HORIZON = new THREE.Color(0.66, 0.74, 0.84);

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

  const ocean = createOcean(sunDir, scene.environment);
  scene.add(ocean);
  scene.add(createClouds());

  return {
    sunDir,
    ocean,
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

// Analytic ocean: a spread of deep-water waves plus scrolling noise, evaluated
// per fragment for the normal only (the surface itself stays flat). Driven by
// scene time, so it rewinds with the timeline.
//
// The shading follows web-ocean (github.com/noniv/web-ocean, MIT, by noniv), adapted to analytic waves:
// - LEAN-style slope statistics: each wave's slope variance (a·k)²/2 along its direction is moved from
//   the resolved normal into a roughness covariance as it fades out with distance, plus unresolved
//   capillary roughness and the slope variation across the pixel (specular anti-aliasing). So the sun
//   glitter widens with distance and the far sea settles into a sheen instead of aliasing.
// - Sun glitter from an anisotropic Gaussian slope distribution with Smith masking.
// - Sky reflection from the scene's PMREM sky, blurred by that roughness, with the reflector tilted
//   toward the viewer at grazing angles (the facets you can see there face you).
const WAVE_COUNT = 16;

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
    const L = 95 * 0.73 ** i * (0.85 + 0.3 * rng());
    wl.push(L);
    amp.push(((0.055 + 0.03 * rng()) * L) / (2 * Math.PI)); // steepness a·k ≈ 0.055–0.085
    phase.push(rng() * Math.PI * 2);
  }
  return { dirs, wl, amp, phase };
}

// Constants three.js would derive for a PMREM (cube-UV) environment map; see generateCubeUVSize in WebGLProgram.
function cubeUVDefines(tex) {
  const h = tex.image.height;
  const maxMip = Math.log2(h) - 2;
  return {
    ENVMAP_TYPE_CUBE_UV: '',
    CUBEUV_TEXEL_WIDTH: (1 / (3 * Math.max(2 ** maxMip, 7 * 16))).toFixed(10),
    CUBEUV_TEXEL_HEIGHT: (1 / h).toFixed(10),
    CUBEUV_MAX_MIP: maxMip.toFixed(1),
  };
}

function createOcean(sunDir, envMap) {
  const waves = waveSet();
  const material = new THREE.ShaderMaterial({
    defines: cubeUVDefines(envMap),
    uniforms: {
      uEnv: { value: envMap },
      uEnvGain: { value: 0.32 }, // the Sky shader's radiance, brought down to the water's exposure
      uSunE: { value: 9.0 }, // sun irradiance for the glitter
      uTime: { value: 0 },
      uSunDir: { value: sunDir },
      uSunColor: { value: new THREE.Color(1.0, 0.93, 0.8) },
      uDeep: { value: new THREE.Color(0.006, 0.045, 0.085) },
      uScatter: { value: new THREE.Color(0.02, 0.13, 0.16) },
      uHorizon: { value: HORIZON },
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
      uniform vec3 uSunDir, uSunColor, uDeep, uScatter, uHorizon;
      uniform float uFogNear, uFogFar, uShipX;
      uniform vec2 uDirs[NW];
      uniform float uWl[NW], uAmp[NW], uPhase[NW];
      uniform sampler2D uEnv;
      uniform float uEnvGain, uSunE;
      varying vec3 vWorld;

      #include <common>
      #include <cube_uv_reflection_fragment>

      // Schlick with F0 for water (n = 1.333).
      float fresnelWater(float c) {
        float x = 1.0 - clamp(c, 0.0, 1.0);
        float x2 = x * x;
        return 0.02 + 0.98 * x2 * x2 * x;
      }
      // Smith masking for an anisotropic Gaussian slope distribution with covariance cov (xx, zz, xz).
      float lambdaSmith(vec3 w, vec3 cov) {
        float xz2 = max(dot(w.xz, w.xz), 1e-8);
        float il = inversesqrt(xz2);
        vec2 az = w.xz * il;
        float sig2 = az.x * az.x * cov.x + az.y * az.y * cov.y + 2.0 * az.x * az.y * cov.z;
        float a = max(w.y * il, 1e-3) / sqrt(2.0 * max(sig2, 1e-7));
        if (a >= 1.6) return 0.0;
        return (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a);
      }

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
        return s;
      }
      // Waterline half-beam of the frigate (mirrors widthFactor() in ship.js).
      float hullHalf(float x) {
        float u = (x + 60.0) / 115.5;
        if (u < 0.0 || u > 1.0) return -1.0;
        float w = u < 0.56 ? 0.93 + 0.07 * min(u / 0.12, 1.0) : pow(max(0.0, 1.0 - pow((u - 0.56) / 0.44, 2.1)), 0.62);
        return 6.35 * w;
      }
      // Foam: bow wave hugging the hull, churned wake astern and faint Kelvin
      // arms. Broken up by noise so it reads as patches, not painted stripes.
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
        float n = fbm(p * 0.22 + vec2(uTime * 0.03, -uTime * 0.02));
        float n2 = vnoise(p * 1.3 - uTime * 0.1);
        float patchy = smoothstep(0.62 - 0.45 * f, 0.95 - 0.3 * f, n * 0.75 + n2 * 0.35);
        return clamp(f * patchy * 1.4, 0.0, 1.0) * (1.0 - smoothstep(1500.0, 4000.0, dist));
      }

      void main() {
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        vec2 grad = vec2(0.0);
        // Slope covariance (xx, zz, xz) of everything not drawn in the normal (LEAN).
        vec3 cov = vec3(0.0);
        for (int i = 0; i < NW; i++) {
          float k = 6.2831853 / uWl[i];
          float w = sqrt(9.81 * k);
          // Fade each wave before it aliases (shorter waves fade sooner); what fades becomes roughness.
          float fade = 1.0 - smoothstep(uWl[i] * 12.0, uWl[i] * 60.0, dist);
          float ph = dot(uDirs[i], vWorld.xz) * k - w * uTime + uPhase[i];
          float A = uAmp[i] * k;
          vec2 d = uDirs[i];
          grad += d * (A * cos(ph) * fade);
          cov += (0.5 * A * A * (1.0 - fade * fade)) * vec3(d.x * d.x, d.y * d.y, d.x * d.y);
        }
        // Fine capillary chop from scrolling noise, near the camera only; farther out it is roughness.
        float capFade = 1.0 - smoothstep(20.0, 250.0, dist);
        if (capFade > 0.0) {
          float e = 0.35;
          vec2 q = vWorld.xz * 0.9 + vec2(uTime * 0.6, uTime * 0.35);
          float n0 = fbm(q);
          vec2 ng = vec2(fbm(q + vec2(e, 0.0)) - n0, fbm(q + vec2(0.0, e)) - n0) / e;
          grad += ng * 0.22 * capFade;
        }
        // Unresolved capillary roughness (always there), the faded noise chop, and the sun's disc.
        cov.xy += 0.0016 + 0.0028 * (1.0 - capFade) + 2.0e-5;
        // Specular anti-aliasing: slope variation across the pixel widens the lobe.
        vec2 dsx = dFdx(grad);
        vec2 dsy = dFdy(grad);
        vec3 aa = vec3(dsx.x * dsx.x + dsy.x * dsy.x, dsx.y * dsx.y + dsy.y * dsy.y, dsx.x * dsx.y + dsy.x * dsy.y) * 0.5;
        cov += aa * min(1.0, 0.03 / max(max(aa.x, aa.y), 1e-8));

        vec3 n = normalize(vec3(-grad.x, 1.0, -grad.y));
        vec3 L = uSunDir;

        // ---- sun glitter: anisotropic Gaussian slope distribution, Smith masking ----
        vec3 Hv = normalize(V + L);
        vec2 hs = -Hv.xz / max(Hv.y, 1e-3);
        vec2 dsl = hs + grad; // the half vector's slope minus the drawn slope (the drawn slope is -grad)
        float det = max(cov.x * cov.y - cov.z * cov.z, 1e-10);
        float ex = (dsl.x * dsl.x * cov.y + dsl.y * dsl.y * cov.x - 2.0 * dsl.x * dsl.y * cov.z) / det;
        float pdf = exp(-0.5 * ex) / (6.2831853 * sqrt(det));
        float hy2 = Hv.y * Hv.y;
        float Dm = pdf / max(hy2 * hy2, 1e-6);
        float G = 1.0 / (1.0 + lambdaSmith(V, cov) + lambdaSmith(L, cov));
        vec3 spec = uSunColor * uSunE * (fresnelWater(dot(V, Hv)) * Dm * G / (4.0 * max(V.y, 0.02))) * step(0.0, L.y);

        // ---- sky reflection, blurred by the roughness ----
        float sig = sqrt(max(cov.x + cov.y, 1e-6) * 0.5);
        vec3 vh = normalize(vec3(V.x, 0.0, V.z) + vec3(1e-5, 0.0, 0.0));
        float sigV = sqrt(max(vh.x * vh.x * cov.x + vh.z * vh.z * cov.y + 2.0 * vh.x * vh.z * cov.z, 1e-6));
        float aV = max(V.y, 1e-3) / max(sqrt(1.0 - V.y * V.y), 1e-3) / (1.4142 * sigV);
        vec3 nV = normalize(n + vh * (0.32 * sigV * (1.0 - smoothstep(0.0, 2.5, aV))));
        vec3 R = reflect(-V, nV);
        R.y = abs(R.y) * 0.4 + max(R.y, 0.0) * 0.6;
        R = normalize(R);
        // A GGX alpha of about sigma * sqrt(2); three's roughness is the square root of alpha.
        float rough = clamp(sqrt(sig * 1.4142), 0.02, 1.0);
        vec3 sky = textureCubeUV(uEnv, R, rough).rgb * uEnvGain;
        // Fresnel from a partly smoothed normal: visible facets at grazing incidence stay reflective.
        float fresnel = fresnelWater(max(dot(normalize(mix(n, vec3(0.0, 1.0, 0.0), 0.45)), V), 0.0));

        // ---- water body: upwelling scatter, subsurface tint on faces toward the viewer ----
        float ndv = max(dot(n, V), 0.0);
        float sss = pow(max(dot(normalize(vec3(grad.x, 0.2, grad.y)), -V), 0.0), 2.0);
        vec3 water = mix(uDeep, uScatter, 0.25 + 0.5 * pow(ndv, 2.0) + 0.6 * sss);
        vec3 col = mix(water, sky, fresnel) + spec;
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
    sprite.scale.set(size, size * 0.5, 1);
    group.add(sprite);
  }
  return group;
}
