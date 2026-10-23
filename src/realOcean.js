import * as THREE from 'three';
import { fromDisplay, srgbToLinear } from './looks.js';
import { WAVES, makeSea } from './seaWaves.js';

// The sea of the Surface battle (opt-in: createEnvironment({ realSea: true })). Unlike the shared analytic ocean (a flat plane whose
// normals ripple), this one has real waves: a radial grid, dense under the camera and thinning to the horizon, is displaced by a dozen
// Gerstner waves (seaWaves.js, the very table the ships ride), and each pixel shades the same waves analytically.
//   - long swell and short chop travel at their true speeds (deep water: w = sqrt(g k)) along a wind direction, each with its own scatter
//   - crests pinch (Gerstner), and the foam sits where they do (the Jacobian of the surface), with streaks along the wind in a high sea
//   - the sky is mirrored by Fresnel, the sun's glitter widens with the roughness, light shows through the crests (a greener, brighter water)
//   - waves finer than a pixel fade out of the normal (their lost slope becomes roughness), so nothing shimmers at a distance
// The wake foam of the shared ocean is not here: each ship has her own wake ribbon (fx/wake.js).

function radialGeometry(rings = 130, sectors = 144, r0 = 3, r1 = 32000) {
  const pos = new Float32Array(((rings + 1) * sectors + 1) * 3);
  let n = 3; // vertex 0 is the centre
  for (let j = 0; j <= rings; j++) {
    const r = r0 * Math.pow(r1 / r0, j / rings);
    for (let s = 0; s < sectors; s++) {
      const a = (2 * Math.PI * s) / sectors;
      pos[n++] = Math.cos(a) * r; pos[n++] = 0; pos[n++] = Math.sin(a) * r;
    }
  }
  const idx = [];
  const at = (j, s) => 1 + j * sectors + (s % sectors);
  for (let s = 0; s < sectors; s++) idx.push(0, at(0, s + 1), at(0, s));
  for (let j = 0; j < rings; j++) {
    for (let s = 0; s < sectors; s++) {
      const a = at(j, s), b = at(j, s + 1), c = at(j + 1, s), d = at(j + 1, s + 1);
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

export function createRealOcean(sunDir, horizon, look, zenithCol, windDir = Math.PI - 0.6) {
  const sunLin = new THREE.Color(...look.sunColor.map((c) => (c / 255) ** 2.2));
  const deck = look.overcast;
  const deep = new THREE.Color(0.006, 0.045, 0.085).lerp(new THREE.Color(0.012, 0.03, 0.045), deck);
  const scatter = new THREE.Color(0.02, 0.13, 0.16).lerp(new THREE.Color(0.035, 0.07, 0.08), deck);
  scatter.multiplyScalar(0.55 + 0.45 * Math.min(look.sunI / 2.7, 1));
  scatter.lerp(new THREE.Color(...srgbToLinear(look.horizon)).multiplyScalar(0.1), look.warm * 0.8);
  const w1 = Array.from({ length: WAVES }, () => new THREE.Vector4());
  const w2 = Array.from({ length: WAVES }, () => new THREE.Vector4());
  const material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: sunDir },
      uSunColor: { value: sunLin },
      uDeep: { value: deep },
      uScatter: { value: scatter },
      uHorizon: { value: horizon },
      uZenith: { value: zenithCol },
      uFogNear: { value: look.fog[0] },
      uFogFar: { value: look.fog[1] },
      uSky: { value: look.skyStops.map((c) => new THREE.Color(...fromDisplay(c))) },
      uSea: { value: look.sea.state },
      uHs: { value: 1 },
      uWindDir: { value: new THREE.Vector2(Math.cos(windDir), Math.sin(windDir)) },
      uCaps: { value: look.sea.caps },
      uGlitter: { value: look.sea.glitter },
      uReflect: { value: look.sea.reflect },
      uFoamTint: { value: 0.6 },
      uShipX: { value: 0 }, // kept so the callers that park the shared ocean's wake can set it; unused here
      uGrid: { value: 0 },
      uRingC: { value: new THREE.Vector2() },
      uW1: { value: w1 }, // dx, dz, k, a
      uW2: { value: w2 }, // w, phase, Q, wavelength
    },
    vertexShader: /* glsl */ `
      #define NW ${WAVES}
      uniform float uTime;
      uniform vec4 uW1[NW];
      uniform vec4 uW2[NW];
      varying vec3 vWorld;
      varying vec2 vParam;
      void main() {
        vec2 xz = (modelMatrix * vec4(position, 1.0)).xz;
        float r = length(position.xz);
        float spacing = 0.075 * max(r, 3.0); // about the distance between neighbouring vertices here
        vec3 d = vec3(0.0);
        for (int i = 0; i < NW; i++) {
          float lam = uW2[i].w;
          float keep = 1.0 - smoothstep(lam / 9.0, lam / 4.5, spacing); // a wave the grid cannot hold here is left to the shading
          float ph = uW1[i].z * dot(uW1[i].xy, xz) - uW2[i].x * uTime + uW2[i].y;
          float a = uW1[i].w * keep;
          d.y += a * sin(ph);
          d.xz += uW2[i].z * a * uW1[i].xy * cos(ph);
        }
        vParam = xz;
        vWorld = vec3(xz.x + d.x, d.y, xz.y + d.z);
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      #define NW ${WAVES}
      uniform float uTime;
      uniform vec3 uSunDir, uSunColor, uDeep, uScatter, uHorizon, uZenith;
      uniform float uFogNear, uFogFar, uSea, uHs, uCaps, uGlitter, uReflect, uFoamTint;
      uniform vec3 uSky[4];
      uniform vec2 uWindDir;
      uniform vec4 uW1[NW];
      uniform vec4 uW2[NW];
      varying vec3 vWorld;
      varying vec2 vParam;

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
      float vnoise(vec2 p) { return noised(p).z; }

      void main() {
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        float fp = length(fwidth(vParam)); // metres on the sea per pixel
        // The waves, evaluated where this pixel's water came from: slope, height and how much the crest pinches (the Jacobian).
        vec2 slope = vec2(0.0);
        float h = 0.0, pinch = 0.0, lost = 0.0;
        for (int i = 0; i < NW; i++) {
          float lam = uW2[i].w;
          float keep = 1.0 - smoothstep(0.1 * lam, 0.45 * lam, fp); // wavelengths near a pixel fade out of the normal
          float ka = uW1[i].z * uW1[i].w;
          float ph = uW1[i].z * dot(uW1[i].xy, vParam) - uW2[i].x * uTime + uW2[i].y;
          float s = sin(ph), c = cos(ph);
          slope += uW1[i].xy * (ka * c) * keep;
          h += uW1[i].w * s * keep;
          pinch += uW2[i].z * ka * s * keep;
          lost += ka * ka * (1.0 - keep) * (1.0 - keep);
        }
        // Fine ripples on top, driven by the wind (a rougher sea has more of them), also faded by the pixel footprint.
        float rip = (0.035 + 0.03 * min(uSea, 4.0)) * (1.0 - smoothstep(0.5, 2.0, fp));
        vec2 wp = vParam - uWindDir * (uTime * 1.2);
        vec3 n1 = noised(wp / 2.6), n2 = noised(vec2(wp.y, -wp.x) / 1.15 + 9.0);
        slope += (n1.xy - 0.0) * rip * 0.9 + (n2.xy) * rip * 0.5;
        // Far water flattens to its average slope instead of shimmering.
        float far = smoothstep(900.0, 7000.0, dist);
        slope *= 1.0 - 0.7 * far;
        vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
        vec3 v = toCam / dist;
        float ndv = max(dot(n, v), 0.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        vec3 r = reflect(-v, n);
        r.y = abs(r.y);
        float skyT = pow(clamp(r.y, 0.0, 1.0), 0.55);
        vec3 sky = skyT < 0.28 ? mix(uSky[0], uSky[1], skyT / 0.28)
                 : skyT < 0.52 ? mix(uSky[1], uSky[2], (skyT - 0.28) / 0.24)
                 : mix(uSky[2], uSky[3], (skyT - 0.52) / 0.48);
        // Light through the crests: the higher and steeper the water, the greener and brighter it is.
        float hN = clamp(h / max(uHs * 0.7, 0.2) * 0.5 + 0.5, 0.0, 1.0);
        float facing = pow(max(dot(normalize(vec3(slope.x, 0.25, slope.y)), -v), 0.0), 2.0);
        float sss = pow(hN, 3.0) * (0.35 + 0.65 * facing) + 0.4 * facing * hN;
        vec3 water = mix(uDeep, uScatter, 0.2 + 0.45 * ndv * ndv + 0.9 * sss);
        water += uScatter * 0.5 * sss;
        // The sun's glitter, wider on a rough sea and where the fine waves have been averaged away.
        float rough = clamp(0.08 + 0.05 * uSea + 8.0 * lost, 0.05, 0.8);
        float sunDot = max(dot(r, uSunDir), 0.0);
        float e1 = mix(1400.0, 60.0, rough), e2 = mix(120.0, 14.0, rough);
        vec3 spec = uSunColor * (pow(sunDot, e1) * 3.5 + pow(sunDot, e2) * 0.12) * uGlitter;
        vec3 col = mix(water, sky, fresnel * uReflect) + spec;
        // Foam: where the crests pinch (a breaking sea), patchy, plus streaks along the wind in a high sea; it fades with distance.
        float J = 1.0 - pinch;
        float groups = smoothstep(0.3, 0.68, vnoise(vParam * 0.018 + vec2(uTime * 0.04, 3.0))); // whitecaps come in groups of waves, not along every crest
        float crest = smoothstep(0.3, 0.03, J) * smoothstep(0.4, 0.85, hN) * (0.15 + 0.85 * groups);
        float patch1 = vnoise(vParam * 0.55 + vec2(uTime * 0.2, -uTime * 0.13));
        float patch2 = vnoise(vParam * 2.3 - uTime * 0.4);
        float patch3 = vnoise(vParam * 7.0 + uTime * 0.3);
        float patch4 = vnoise(vParam * 15.0 - uTime * 0.6);
        float broken = smoothstep(0.46, 0.76, patch1 * 0.45 + patch2 * 0.35 + patch3 * 0.3 + (patch4 - 0.5) * 0.55); // foam in flecks, not lines
        vec2 sw = vec2(dot(vParam, uWindDir), dot(vParam, vec2(-uWindDir.y, uWindDir.x)));
        float streak = smoothstep(0.58, 0.82, vnoise(vec2(sw.x * 0.09 - uTime * 0.5, sw.y * 0.5))) * smoothstep(2.2, 4.2, uSea) * broken;
        float footFade = (1.0 - smoothstep(1.5, 6.0, fp)) * (1.0 - smoothstep(700.0, 3600.0, dist));
        float foam = clamp((crest * broken * 1.3 + streak * 0.4) * uCaps * footFade, 0.0, 0.8);
        vec3 foamCol = vec3(0.95, 0.97, 0.98) * (0.55 + 0.45 * max(uSunDir.y, 0.0)) * mix(1.0, 0.8, 1.0 - hN);
        foamCol *= mix(vec3(1.0), uSunColor / max(max(uSunColor.r, uSunColor.g), uSunColor.b), uFoamTint);
        col = mix(col, foamCol, foam);
        col = mix(col, uHorizon, smoothstep(uFogNear, uFogFar, dist));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(radialGeometry(), material);
  mesh.name = 'ocean';
  mesh.frustumCulled = false;
  // Feed the uniforms from a sea table; returns the table so the caller can ride the ships on it.
  mesh.userData.setTable = (sea) => {
    sea.waves.forEach((v, i) => { w1[i].set(v.dx, v.dz, v.k, v.a); w2[i].set(v.w, v.ph, v.Q, v.lam); });
    material.uniforms.uHs.value = sea.Hs;
    material.uniforms.uSea.value = sea.state;
  };
  mesh.userData.windDir = windDir;
  mesh.userData.makeSea = (state) => makeSea(state, windDir);
  mesh.userData.setTable(makeSea(look.sea.state, windDir));
  return mesh;
}
