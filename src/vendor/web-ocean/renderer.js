// web-ocean (github.com/noniv/web-ocean, MIT, see LICENSE; commit a07c7fd) driven by this scene.
// The WGSL in ./wgsl is copied unchanged. This file is the project's adaptation of web-ocean's
// js/main.js: the same simulation, sky, ocean, bloom and composite passes, but
//  - it draws on a canvas it is given (layered under the three.js canvas), at the size it is told;
//  - the camera, the sun direction and the time come from the scene (no input, panel, probe or shots);
//  - time is the scene's sim time t (looped like the original), so the waves are a pure function of t;
//  - foam is the one stateful part (it builds up and decays): it advances with forward time, and when
//    time jumps or runs backwards it is rebuilt by re-running the last FOAM_PREROLL seconds, so a
//    given t always looks the same after a short settle;
//  - speed options (defaults are web-ocean's own): `grid` quads per mesh node (32), `aniso` texture
//    anisotropy (16), `foamEvery` steps per foam update (1), `envEvery` frames per reflected-sky face (1);
//    and work it can skip outright: no simulation when t has not changed, no sky-view LUT rebuild unless
//    the camera altitude or the sun moved. `profile: true` times the stages (the `stats` getter).
// Throws (or rejects) when WebGPU is not available; the caller keeps its WebGL ocean then.
import { N, CASCADES, SKY_W, SKY_H, ENV_SIZE, ENV_MIPS } from './wgsl/common.js';
import { SIM_INIT, SIM_EVOLVE, FFT_ROWS, FFT_COLS, SIM_MIPS, FOAM_TEX, RGBA8_MIPS, FOAM_UPDATE, ARRAY16_MIPS, FOAM_RES } from './wgsl/sim.js';
import { TRANS_LUT, MS_LUT, SKYVIEW_LUT, ENV_CUBE, CUBE_MIPS, SUN_VIS } from './wgsl/sky.js';
import { OCEAN, SKY_BG } from './wgsl/ocean.js';
import { BLOOM_DOWN, BLOOM_UP, COMPOSITE } from './wgsl/post.js';

const D2R = Math.PI / 180;
const CASC_L = [1103.0, 211.3, 39.7, 7.43, 1.393, 0.2617];
const LOOP = 600.0; // s, spectrum time loop (frequencies quantised to it)
const FOAM_PREROLL = 9; // s re-run after a jump
const FOAM_STEP = 0.75; // s per pre-roll step

// web-ocean's tunables. The defaults are its own; the scene overrides a few (see environment.js).
export const DEFAULTS = {
  windSpeed: 7.0, windDir: 118, fetchKm: 90,
  swellHs: 1.8, swellDir: 94, swellLength: 120, swellSpread: 48, choppy: 1.25,
  turbidity: 1.6, foam: 1.0,
  exposure: 1.35, haze: 3.0, clouds: 0.40, veil: 0.36, bloom: 0.10,
};

function mat4Mul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
}

export async function createWebOcean(canvas, settings = {}) {
  if (!globalThis.navigator?.gpu) throw new Error('WebGPU is not available');
  const GU = GPUBufferUsage;
  const TU = GPUTextureUsage;
  const P = { ...DEFAULTS, ...settings };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  // ?oceanProfile=1: GPU time per stage (needs timestamp queries), read through the `stats` getter.
  const profile = !!settings.profile && adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice(profile ? { requiredFeatures: ['timestamp-query'] } : undefined);
  let lost = false;
  device.lost.then(() => { lost = true; });

  const ctx = canvas.getContext('webgpu');
  const swapFormat = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: swapFormat, alphaMode: 'opaque' });

  async function shader(code, label) {
    const m = device.createShaderModule({ code, label });
    const info = await m.getCompilationInfo();
    if (info.messages.some((msg) => msg.type === 'error')) throw new Error(`web-ocean: shader error in ${label}`);
    return m;
  }
  async function computePipe(code, label) {
    const module = await shader(code, label);
    return device.createComputePipelineAsync({ label, layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  // --- Simulation resources ---
  const C = CASCADES;
  const SIM_MIP_COUNT = Math.log2(N) + 1;
  const specBytes = N * N * C * 16;
  const mkBuf = (size, usage, label) => device.createBuffer({ size, usage, label });
  const simUBO = mkBuf(224, GU.UNIFORM | GU.COPY_DST, 'sim ubo');
  const h0Buf = mkBuf(specBytes, GU.STORAGE, 'h0');
  const specA = mkBuf(specBytes, GU.STORAGE, 'specA');
  const specB = mkBuf(specBytes, GU.STORAGE, 'specB');
  const tmpA = mkBuf(specBytes, GU.STORAGE, 'tmpA');
  const tmpB = mkBuf(specBytes, GU.STORAGE, 'tmpB');
  const mkSimTex = (label) => device.createTexture({
    label, size: [N, N, C], format: 'rgba16float', mipLevelCount: SIM_MIP_COUNT,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  const dispTex = mkSimTex('disp');
  const derivTex = mkSimTex('deriv');
  const momTex = mkSimTex('moments');
  const lvl = (t, m, dim = '2d-array') => t.createView({ dimension: dim, baseMipLevel: m, mipLevelCount: 1 });
  const fullArr = (t) => t.createView({ dimension: '2d-array' });

  const [initPipe, evolvePipe, rowsPipe, colsPipe, simMipPipe, foamGenPipe, rgba8MipPipe,
    transPipe, msPipe, skyViewPipe, envPipe, cubeMipPipe, foamUpdPipe, arr16MipPipe, sunVisPipe] = await Promise.all([
    computePipe(SIM_INIT, 'sim init'), computePipe(SIM_EVOLVE, 'sim evolve'),
    computePipe(FFT_ROWS, 'fft rows'), computePipe(FFT_COLS, 'fft cols'),
    computePipe(SIM_MIPS, 'sim mips'), computePipe(FOAM_TEX, 'foam tex'), computePipe(RGBA8_MIPS, 'rgba8 mips'),
    computePipe(TRANS_LUT, 'transmittance'), computePipe(MS_LUT, 'multiscatter'), computePipe(SKYVIEW_LUT, 'skyview'),
    computePipe(ENV_CUBE, 'env cube'), computePipe(CUBE_MIPS, 'cube mips'), computePipe(FOAM_UPDATE, 'foam update'),
    computePipe(ARRAY16_MIPS, 'array16 mips'), computePipe(SUN_VIS, 'sun visibility'),
  ]);

  const bg = (pipe, entries, label) => device.createBindGroup({
    label, layout: pipe.getBindGroupLayout(0), entries: entries.map((r, i) => ({ binding: i, resource: r })),
  });
  const bgInit = bg(initPipe, [{ buffer: simUBO }, { buffer: h0Buf }], 'init');
  const bgEvolve = bg(evolvePipe, [{ buffer: simUBO }, { buffer: h0Buf }, { buffer: specA }, { buffer: specB }], 'evolve');
  const bgRows = bg(rowsPipe, [{ buffer: specA }, { buffer: specB }, { buffer: tmpA }, { buffer: tmpB }], 'rows');
  const bgCols = bg(colsPipe, [{ buffer: tmpA }, { buffer: tmpB }, lvl(dispTex, 0), lvl(derivTex, 0), lvl(momTex, 0)], 'cols');
  const bgSimMips = [];
  for (let m = 1; m < SIM_MIP_COUNT; m++) {
    bgSimMips.push(bg(simMipPipe, [lvl(dispTex, m - 1), lvl(derivTex, m - 1), lvl(momTex, m - 1),
      lvl(dispTex, m), lvl(derivTex, m), lvl(momTex, m)], 'simmip' + m));
  }

  // Foam micro-structure texture (generated once)
  const FOAM_SIZE = 512;
  const FOAM_MIPS = 10;
  const foamTex = device.createTexture({
    label: 'foam detail', size: [FOAM_SIZE, FOAM_SIZE], format: 'rgba8unorm', mipLevelCount: FOAM_MIPS,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  {
    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(foamGenPipe);
    cp.setBindGroup(0, bg(foamGenPipe, [lvl(foamTex, 0, '2d')]));
    cp.dispatchWorkgroups(FOAM_SIZE / 8, FOAM_SIZE / 8);
    cp.setPipeline(rgba8MipPipe);
    for (let m = 1; m < FOAM_MIPS; m++) {
      const s = FOAM_SIZE >> m;
      cp.setBindGroup(0, bg(rgba8MipPipe, [lvl(foamTex, m - 1, '2d'), lvl(foamTex, m, '2d')]));
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8));
    }
    cp.end();
    device.queue.submit([enc.finish()]);
  }

  // World-space foam clipmaps (ping-pong)
  const FOAM_LEVEL_SIZE = [128.0, 1024.0];
  const FOAMW_MIPS = Math.log2(FOAM_RES) + 1;
  const foamW = [0, 1].map((i) => device.createTexture({
    label: 'foam world ' + i, size: [FOAM_RES, FOAM_RES, 2], format: 'rgba16float', mipLevelCount: FOAMW_MIPS,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  }));
  const foamUBO = mkBuf(144, GU.UNIFORM | GU.COPY_DST, 'foam ubo');
  const foamUArr = new ArrayBuffer(144);
  const foamUI = new Int32Array(foamUArr);
  const foamUF = new Float32Array(foamUArr);
  const foamSnap = new Int32Array(4);
  let foamFirst = true;
  let foamCur = 0;
  const samplerSim = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat',
  });
  const bgFoamUpd = [0, 1].map((i) => bg(foamUpdPipe, [{ buffer: foamUBO }, lvl(foamW[1 - i], 0), lvl(foamW[i], 0),
    fullArr(dispTex), fullArr(derivTex), samplerSim, samplerSim], 'foamupd' + i));
  const bgFoamMips = [0, 1].map((i) => {
    const out = [];
    for (let m = 1; m < FOAMW_MIPS; m++) out.push(bg(arr16MipPipe, [lvl(foamW[i], m - 1), lvl(foamW[i], m)]));
    return out;
  });

  // --- Atmosphere resources ---
  const atmoUBO = mkBuf(16, GU.UNIFORM | GU.COPY_DST, 'atmo ubo');
  const mkLut = (w, h, label) => device.createTexture({ label, size: [w, h], format: 'rgba16float', usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING });
  const transLUT = mkLut(256, 64, 'transmittance');
  const msLUT = mkLut(32, 32, 'multiscatter');
  const skyLUT = mkLut(SKY_W, SKY_H, 'skyview');
  const envTex = device.createTexture({
    label: 'env cube', size: [ENV_SIZE, ENV_SIZE, 6], format: 'rgba16float', mipLevelCount: ENV_MIPS,
    usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
  });
  const envCubeView = envTex.createView({ dimension: 'cube' });
  const sampClamp = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge',
  });
  const sampRepeat = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: settings.aniso ?? 16,
  });
  const frameUBO = mkBuf(384, GU.UNIFORM | GU.COPY_DST, 'frame ubo');
  const sunVisBuf = mkBuf(16, GU.STORAGE, 'sun visibility');
  const transView = transLUT.createView();
  const msView = msLUT.createView();
  const skyView = skyLUT.createView();
  const bgTrans = bg(transPipe, [{ buffer: atmoUBO }, transView], 'trans');
  const bgMS = bg(msPipe, [{ buffer: atmoUBO }, transView, sampClamp, msView], 'ms');
  const bgSkyView = bg(skyViewPipe, [{ buffer: frameUBO }, transView, msView, sampClamp, skyView], 'skyview');
  const bgEnv = bg(envPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp, lvl(envTex, 0)], 'env');
  const bgSunVis = bg(sunVisPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp, { buffer: sunVisBuf }], 'sunvis');
  const bgCubeMips = [];
  for (let m = 1; m < ENV_MIPS; m++) bgCubeMips.push(bg(cubeMipPipe, [lvl(envTex, m - 1), lvl(envTex, m)], 'cubemip' + m));

  // --- Render pipelines ---
  const MSAA = 4;
  const HDR = 'rgba16float';
  const [oceanMod, skyMod, downMod, upMod, compMod] = await Promise.all([
    shader(OCEAN, 'ocean'), shader(SKY_BG, 'sky'), shader(BLOOM_DOWN, 'bloom down'),
    shader(BLOOM_UP, 'bloom up'), shader(COMPOSITE, 'composite'),
  ]);
  const oceanPipe = await device.createRenderPipelineAsync({
    label: 'ocean', layout: 'auto',
    vertex: {
      module: oceanMod, entryPoint: 'vs',
      buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
    },
    fragment: { module: oceanMod, entryPoint: 'fs', targets: [{ format: HDR }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    multisample: { count: MSAA },
  });
  const skyPipe = await device.createRenderPipelineAsync({
    label: 'sky', layout: 'auto',
    vertex: { module: skyMod, entryPoint: 'vs' },
    fragment: { module: skyMod, entryPoint: 'fs', targets: [{ format: HDR }] },
    primitive: { topology: 'triangle-list' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'equal' },
    multisample: { count: MSAA },
  });
  const downPipe = await device.createRenderPipelineAsync({
    label: 'bloom down', layout: 'auto',
    vertex: { module: downMod, entryPoint: 'vs' },
    fragment: { module: downMod, entryPoint: 'fs', targets: [{ format: HDR }] },
  });
  const add = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
  const upPipe = await device.createRenderPipelineAsync({
    label: 'bloom up', layout: 'auto',
    vertex: { module: upMod, entryPoint: 'vs' },
    fragment: { module: upMod, entryPoint: 'fs', targets: [{ format: HDR, blend: { color: add, alpha: add } }] },
  });
  const compPipe = await device.createRenderPipelineAsync({
    label: 'composite', layout: 'auto',
    vertex: { module: compMod, entryPoint: 'vs' },
    fragment: { module: compMod, entryPoint: 'fs', targets: [{ format: swapFormat }] },
  });
  const bgOcean = [0, 1].map((i) => bg(oceanPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp,
    fullArr(dispTex), fullArr(derivTex), fullArr(momTex), foamTex.createView(), envCubeView, sampRepeat,
    fullArr(foamW[i]), { buffer: sunVisBuf }], 'ocean' + i));
  const bgSky = bg(skyPipe, [{ buffer: frameUBO }, transView, skyView, sampClamp], 'sky');

  // --- CDLOD grid mesh ---
  // Quads per CDLOD node edge. web-ocean uses 32 (6.25 cm near the camera, a few pixels per quad on a
  // big screen); fewer quads give the same per-pixel shading (normals, glitter and foam come from
  // textures) with far fewer, larger triangles. Must be even (the morph collapses odd vertices).
  const GRID = settings.grid ?? 32;
  const LEAF = 2.0;
  const R0 = 8 * LEAF;
  const LODS = 17;
  const MAX_DIST = 160000;
  const MAX_NODES = 8192;
  const idx = new Uint16Array(GRID * GRID * 6);
  {
    let k = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = i + j * (GRID + 1), b = a + 1, c = a + GRID + 1, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = d;
        idx[k++] = a; idx[k++] = d; idx[k++] = b;
      }
    }
  }
  const idxBuf = mkBuf(idx.byteLength, GU.INDEX | GU.COPY_DST, 'grid idx');
  device.queue.writeBuffer(idxBuf, 0, idx);
  const instData = new Float32Array(MAX_NODES * 4);
  const instBuf = mkBuf(instData.byteLength, GU.VERTEX | GU.COPY_DST, 'instances');

  // --- Screen-size dependent targets ---
  const BLOOM_LEVELS = 8;
  const linSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const compUBO = mkBuf(32, GU.UNIFORM | GU.COPY_DST, 'composite ubo');
  const compData = new Float32Array(8);
  const bloomUBOs = [];
  for (let i = 0; i < BLOOM_LEVELS * 2; i++) bloomUBOs.push(mkBuf(16, GU.UNIFORM | GU.COPY_DST, 'bloom ubo'));
  let W = 0;
  let H = 0;
  let colorMS, depthMS, hdrTex, bloomTex;
  const mainPass = {
    colorAttachments: [{ view: null, resolveTarget: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
    depthStencilAttachment: { view: null, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
  };
  const compPass = { colorAttachments: [{ view: null, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] };
  let downPasses = [], upPasses = [], downBGs = [], upBGs = [], bgComp = null;

  function resize(w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === W && h === H) return;
    W = w; H = h;
    canvas.width = W; canvas.height = H;
    for (const t of [colorMS, depthMS, hdrTex, bloomTex]) t?.destroy();
    colorMS = device.createTexture({ size: [W, H], format: HDR, sampleCount: MSAA, usage: TU.RENDER_ATTACHMENT });
    depthMS = device.createTexture({ size: [W, H], format: 'depth32float', sampleCount: MSAA, usage: TU.RENDER_ATTACHMENT });
    hdrTex = device.createTexture({ size: [W, H], format: HDR, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    const bw = Math.max(1, W >> 1), bh = Math.max(1, H >> 1);
    bloomTex = device.createTexture({ size: [bw, bh], format: HDR, mipLevelCount: BLOOM_LEVELS, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    mainPass.colorAttachments[0].view = colorMS.createView();
    mainPass.colorAttachments[0].resolveTarget = hdrTex.createView();
    mainPass.depthStencilAttachment.view = depthMS.createView();
    const hdrView = hdrTex.createView();
    const bv = [];
    for (let m = 0; m < BLOOM_LEVELS; m++) bv.push(bloomTex.createView({ baseMipLevel: m, mipLevelCount: 1 }));
    downPasses = []; upPasses = []; downBGs = []; upBGs = [];
    const tmp = new Float32Array(4);
    for (let m = 0; m < BLOOM_LEVELS; m++) {
      const srcW = m === 0 ? W : Math.max(1, bw >> (m - 1));
      const srcH = m === 0 ? H : Math.max(1, bh >> (m - 1));
      tmp[0] = 1 / srcW; tmp[1] = 1 / srcH; tmp[2] = m === 0 ? 1 : 0; tmp[3] = 0;
      device.queue.writeBuffer(bloomUBOs[m], 0, tmp);
      downBGs.push(bg(downPipe, [m === 0 ? hdrView : bv[m - 1], linSamp, { buffer: bloomUBOs[m] }]));
      downPasses.push({ colorAttachments: [{ view: bv[m], clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    }
    for (let m = BLOOM_LEVELS - 1; m > 0; m--) {
      const sw = Math.max(1, bw >> m), sh = Math.max(1, bh >> m);
      tmp[0] = 1 / sw; tmp[1] = 1 / sh; tmp[2] = 1.0; tmp[3] = 1.0;
      const ubo = bloomUBOs[BLOOM_LEVELS + m];
      device.queue.writeBuffer(ubo, 0, tmp);
      upBGs.push(bg(upPipe, [bv[m], linSamp, { buffer: ubo }]));
      upPasses.push({ colorAttachments: [{ view: bv[m - 1], loadOp: 'load', storeOp: 'store' }] });
    }
    bgComp = bg(compPipe, [hdrView, bv[0], linSamp, { buffer: compUBO }]);
  }

  // --- Uniform data ---
  const simF = new Float32Array(56);
  const frameF = new Float32Array(96);
  const atmoF = new Float32Array(4);
  const proj = new Float32Array(16), view = new Float32Array(16), viewProj = new Float32Array(16);
  let needSpectrum = true;
  let needLUT = true;
  let envFull = 2;
  let frameIndex = 0;
  // The camera, from the scene: position, unit right / up / forward vectors and vertical field of view.
  const cam = { x: 0, y: 10, z: 0, r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, -1], fovY: 50 * D2R };
  const sun = [0, 1, 0];

  function writeSimStatic() {
    for (let c = 0; c < C; c++) {
      const L = CASC_L[c];
      simF[c] = L;
      simF[8 + c] = c === 0 ? Math.PI / L : (2 * Math.PI * 6) / L;
      simF[16 + c] = c < C - 1 ? (2 * Math.PI * 6) / CASC_L[c + 1] : (Math.PI * N / L) * 0.98;
    }
    for (let c = 1; c < C; c++) simF[8 + c] = simF[16 + c - 1];
    simF[40] = P.windSpeed; simF[41] = P.windDir * D2R; simF[42] = P.fetchKm * 1000; simF[43] = 3.3;
    const ks = 2 * Math.PI / P.swellLength;
    simF[44] = P.swellHs; simF[45] = P.swellDir * D2R; simF[46] = Math.sqrt(9.81 * ks); simF[47] = P.swellSpread;
    simF[48] = P.choppy; simF[49] = 0.0012; simF[50] = LOOP; simF[51] = 1;
    simF[54] = 2.2; simF[55] = 1.0;
  }

  function writeFrame(time) {
    const aspect = W / H;
    const tanY = Math.tan(cam.fovY * 0.5), tanX = tanY * aspect;
    proj.fill(0);
    proj[0] = 1 / tanX; proj[5] = 1 / tanY; proj[11] = -1; proj[14] = 0.05;
    const [rx, ry, rz] = cam.r;
    const [ux, uy, uz] = cam.u;
    const [fx, fy, fz] = cam.f;
    view.fill(0);
    view[0] = rx; view[4] = ry; view[8] = rz;
    view[1] = ux; view[5] = uy; view[9] = uz;
    view[2] = -fx; view[6] = -fy; view[10] = -fz;
    view[15] = 1;
    mat4Mul(viewProj, proj, view);
    const f = frameF;
    f.set(viewProj, 0);
    f[16] = cam.x; f[17] = cam.y; f[18] = cam.z; f[19] = time;
    f[20] = rx * tanX; f[21] = ry * tanX; f[22] = rz * tanX; f[23] = 0;
    f[24] = ux * tanY; f[25] = uy * tanY; f[26] = uz * tanY; f[27] = 0;
    f[28] = fx; f[29] = fy; f[30] = fz; f[31] = 0;
    f[32] = sun[0]; f[33] = sun[1]; f[34] = sun[2]; f[35] = 14.0;
    f[36] = W; f[37] = H; f[38] = 1 / W; f[39] = 1 / H;
    for (let c = 0; c < C; c++) { f[40 + c] = CASC_L[c]; f[48 + c] = 1 / CASC_L[c]; }
    f[56] = Math.cos(P.windDir * D2R); f[57] = Math.sin(P.windDir * D2R); f[58] = P.windSpeed;
    f[64] = R0; f[65] = GRID; f[66] = FOAM_LEVEL_SIZE[0]; f[67] = FOAM_LEVEL_SIZE[1];
    f[68] = P.exposure; f[69] = P.bloom; f[70] = frameIndex; f[71] = 0;
    f[72] = P.haze; f[73] = Math.max(cam.y, 10) * 0.001; f[74] = P.veil; f[75] = 0.9;
    f[76] = 0.016 * P.turbidity; f[77] = 0.080 * P.turbidity; f[78] = 0.096 * P.turbidity; f[79] = 0.0024;
    f[80] = 0.035; f[81] = 0.120; f[82] = 0.085; f[83] = 2.6;
    f[84] = 0.36 + 0.12 * P.foam; f[85] = 2.5; f[86] = 1.0; f[87] = 1.0;
    f[88] = (5.802e-3 + 4.40e-3 * P.haze) * 1e-3;
    f[89] = (13.558e-3 + 4.40e-3 * P.haze) * 1e-3;
    f[90] = (33.1e-3 + 4.40e-3 * P.haze) * 1e-3;
    f[91] = 1.1e-4;
    f[92] = 1.5; f[93] = P.clouds; f[94] = 2.2; f[95] = time;
    device.queue.writeBuffer(frameUBO, 0, f);
  }

  function writeFoamUniforms(dt) {
    for (let l = 0; l < 2; l++) {
      const ts = FOAM_LEVEL_SIZE[l] / FOAM_RES;
      const cx = Math.floor(cam.x / ts), cz = Math.floor(cam.z / ts);
      foamUI[l * 4] = cx; foamUI[l * 4 + 1] = cz;
      // first frame (or after a reset): pretend the previous window was far away so everything is cleared
      foamUI[l * 4 + 2] = foamFirst ? cx + 100000 : foamSnap[l * 2];
      foamUI[l * 4 + 3] = foamFirst ? cz + 100000 : foamSnap[l * 2 + 1];
      foamSnap[l * 2] = cx; foamSnap[l * 2 + 1] = cz;
      foamUF[8 + l] = ts;
    }
    foamFirst = false;
    foamUF[10] = dt; foamUF[11] = 0.22;
    foamUF[12] = 0.52 + 0.16 * P.foam; foamUF[13] = 2.0; foamUF[14] = 1.0; foamUF[15] = 0;
    for (let c = 0; c < C; c++) { foamUF[16 + c] = CASC_L[c]; foamUF[24 + c] = 1 / CASC_L[c]; }
    const drift = 0.03 * P.windSpeed;
    foamUF[32] = Math.cos(P.windDir * D2R) * drift; foamUF[33] = Math.sin(P.windDir * D2R) * drift;
    device.queue.writeBuffer(foamUBO, 0, foamUArr);
  }

  // One simulation step at `time` (waves, then the foam advanced by dt).
  function encodeSim(cp, doFoam = true) {
    cp.setPipeline(evolvePipe);
    cp.setBindGroup(0, bgEvolve);
    cp.dispatchWorkgroups(N / 16, N / 16, C);
    cp.setPipeline(rowsPipe);
    cp.setBindGroup(0, bgRows);
    cp.dispatchWorkgroups(N, 1, C);
    cp.setPipeline(colsPipe);
    cp.setBindGroup(0, bgCols);
    cp.dispatchWorkgroups(N, 1, C);
    cp.setPipeline(simMipPipe);
    for (let m = 1; m < SIM_MIP_COUNT; m++) {
      const s = N >> m;
      cp.setBindGroup(0, bgSimMips[m - 1]);
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), C);
    }
    if (!doFoam) return;
    foamCur = 1 - foamCur;
    cp.setPipeline(foamUpdPipe);
    cp.setBindGroup(0, bgFoamUpd[foamCur]);
    cp.dispatchWorkgroups(FOAM_RES / 8, FOAM_RES / 8, 2);
    cp.setPipeline(arr16MipPipe);
    const fm = bgFoamMips[foamCur];
    for (let m = 1; m < FOAMW_MIPS; m++) {
      const s = Math.max(1, FOAM_RES >> m);
      cp.setBindGroup(0, fm[m - 1]);
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 2);
    }
  }
  const loopT = (t) => ((t % LOOP) + LOOP) % LOOP;
  // The foam maps (2 x 1024² texels) change slowly; they may be advanced every FOAM_EVERY steps by the
  // time gathered since, which looks the same.
  const FOAM_EVERY = settings.foamEvery ?? 1;
  let foamAcc = 0;
  let simCount = 0;
  function simStep(t, dt, timed = false, forceFoam = false) {
    writeSimStatic();
    simF[52] = loopT(t); simF[53] = dt;
    device.queue.writeBuffer(simUBO, 0, simF);
    foamAcc += dt;
    const doFoam = forceFoam || ++simCount % FOAM_EVERY === 0;
    if (doFoam) { writeFoamUniforms(foamAcc); foamAcc = 0; }
    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass(timed ? tsw(0, 1) : undefined);
    if (needSpectrum) {
      cp.setPipeline(initPipe);
      cp.setBindGroup(0, bgInit);
      cp.dispatchWorkgroups(N / 16, N / 16, C);
      needSpectrum = false;
    }
    encodeSim(cp, doFoam);
    cp.end();
    device.queue.submit([enc.finish()]);
  }

  let lastT = null;
  let lastJumpAt = -1e9;
  let foamStale = false;
  let staleTimer = 0;
  function rebuildFoam(t) {
    foamFirst = true;
    foamAcc = 0;
    for (let s = t - FOAM_PREROLL; s < t - 1e-6; s += FOAM_STEP) simStep(s, FOAM_STEP, false, true);
    simStep(t, FOAM_STEP, false, true);
    foamStale = false;
  }
  let skyAlt = -1;
  let skySun = '';
  const ENV_EVERY = settings.envEvery ?? 1;
  const DEBUG = settings.debug ?? '';

  // GPU timing: [sim, sky+env, ocean+sky draw, bloom+composite] in ms, smoothed.
  const TS = profile ? {
    q: device.createQuerySet({ type: 'timestamp', count: 8 }),
    res: mkBuf(64, GU.QUERY_RESOLVE | GU.COPY_SRC, 'ts resolve'),
    read: mkBuf(64, GU.MAP_READ | GU.COPY_DST, 'ts read'),
    pending: false, ms: [0, 0, 0, 0],
  } : null;
  const tsw = (a, b) => (TS ? { timestampWrites: { querySet: TS.q, beginningOfPassWriteIndex: a, endOfPassWriteIndex: b } } : undefined);

  // Draw one frame for the scene time t and the given three.js camera (world matrix up to date).
  function render(t, camera, sunDir) {
    if (lost || !W) return;
    const e = camera.matrixWorld.elements;
    cam.x = e[12]; cam.y = e[13]; cam.z = e[14];
    cam.r = [e[0], e[1], e[2]];
    cam.u = [e[4], e[5], e[6]];
    cam.f = [-e[8], -e[9], -e[10]];
    cam.fovY = camera.fov * D2R;
    sun[0] = sunDir.x; sun[1] = sunDir.y; sun[2] = sunDir.z;
    frameIndex++;

    // Foam follows forward time; a jump or reverse step rebuilds it from the last few seconds.
    // The same t again (paused, only the camera moved) reuses the last simulation as it is.
    // While the scrub bar is being dragged (jumps in quick succession) the foam is only cleared, and
    // rebuilt once the jumps stop, so dragging stays smooth.
    const dt = lastT === null ? -1 : t - lastT;
    const now = performance.now();
    if (dt === 0) {
      if (foamStale) rebuildFoam(t); // nothing else to simulate
    } else if (dt < 0 || dt > 0.5) {
      if (now - lastJumpAt < 250) {
        foamFirst = true;
        foamAcc = 0;
        simStep(t, FOAM_STEP, false, true);
        foamStale = true;
        clearTimeout(staleTimer);
        staleTimer = setTimeout(() => settings.requestFrame?.(), 300);
      } else {
        rebuildFoam(t);
      }
      lastJumpAt = now;
    } else {
      simStep(t, dt, true);
    }
    lastT = t;

    // Sky, environment cube, ocean surface, bloom and composite (the frame uniforms are for t).
    writeFrame(loopT(t));
    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass(tsw(2, 3));
    if (needLUT) {
      atmoF[0] = P.haze;
      device.queue.writeBuffer(atmoUBO, 0, atmoF);
      cp.setPipeline(transPipe);
      cp.setBindGroup(0, bgTrans);
      cp.dispatchWorkgroups(256 / 8, 64 / 8);
      cp.setPipeline(msPipe);
      cp.setBindGroup(0, bgMS);
      cp.dispatchWorkgroups(32 / 8, 32 / 8);
      needLUT = false;
    }
    // The sky-view LUT depends only on the sun and the camera's altitude: rebuild it when they change.
    const alt = Math.max(cam.y, 10);
    const sunKey = `${sun[0].toFixed(4)},${sun[1].toFixed(4)},${sun[2].toFixed(4)}`;
    if (skyAlt < 0 || Math.abs(alt - skyAlt) > Math.max(50, skyAlt * 0.1) || sunKey !== skySun) {
      skyAlt = alt; skySun = sunKey;
      cp.setPipeline(skyViewPipe);
      cp.setBindGroup(0, bgSkyView);
      cp.dispatchWorkgroups(Math.ceil(SKY_W / 8), Math.ceil(SKY_H / 8));
      cp.setPipeline(sunVisPipe);
      cp.setBindGroup(0, bgSunVis);
      cp.dispatchWorkgroups(1);
      envFull = Math.max(envFull, 1);
    }
    // The reflected sky (clouds drift slowly): one cube face every ENV_EVERY frames, all six when the
    // sky changed. The mips are rebuilt only after a face was.
    if (envFull > 0 || frameIndex % ENV_EVERY === 0) {
      cp.setPipeline(envPipe);
      cp.setBindGroup(0, bgEnv);
      cp.dispatchWorkgroups(ENV_SIZE / 8, ENV_SIZE / 8, envFull > 0 ? 6 : 1);
      if (envFull > 0) envFull--;
      cp.setPipeline(cubeMipPipe);
      for (let m = 1; m < ENV_MIPS; m++) {
        const s = Math.max(1, ENV_SIZE >> m);
        cp.setBindGroup(0, bgCubeMips[m - 1]);
        cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 6);
      }
    }
    cp.end();

    selectAll();
    if (nodeCount) device.queue.writeBuffer(instBuf, 0, instData, 0, nodeCount * 4);
    const rp = enc.beginRenderPass(TS ? { ...mainPass, ...tsw(4, 5) } : mainPass);
    if (nodeCount && !DEBUG.includes('noOcean')) {
      rp.setPipeline(oceanPipe);
      rp.setBindGroup(0, bgOcean[foamCur]);
      rp.setVertexBuffer(0, instBuf);
      rp.setIndexBuffer(idxBuf, 'uint16');
      rp.drawIndexed(GRID * GRID * 6, nodeCount);
    }
    if (!DEBUG.includes('noSky')) {
      rp.setPipeline(skyPipe);
      rp.setBindGroup(0, bgSky);
      rp.draw(3);
    }
    rp.end();
    for (let m = 0; m < BLOOM_LEVELS; m++) {
      const p = enc.beginRenderPass(TS && m === 0 ? { ...downPasses[m], timestampWrites: { querySet: TS.q, beginningOfPassWriteIndex: 6 } } : downPasses[m]);
      p.setPipeline(downPipe);
      p.setBindGroup(0, downBGs[m]);
      p.draw(3);
      p.end();
    }
    for (let i = 0; i < upPasses.length; i++) {
      const p = enc.beginRenderPass(upPasses[i]);
      p.setPipeline(upPipe);
      p.setBindGroup(0, upBGs[i]);
      p.draw(3);
      p.end();
    }
    compData[0] = P.exposure; compData[1] = P.bloom; compData[2] = frameIndex % 64; compData[3] = 0.10;
    compData[4] = 1.05; compData[5] = 1.06; compData[6] = -0.19; compData[7] = 0;
    device.queue.writeBuffer(compUBO, 0, compData);
    compPass.colorAttachments[0].view = ctx.getCurrentTexture().createView();
    const pc = enc.beginRenderPass(TS ? { ...compPass, timestampWrites: { querySet: TS.q, endOfPassWriteIndex: 7 } } : compPass);
    pc.setPipeline(compPipe);
    pc.setBindGroup(0, bgComp);
    pc.draw(3);
    pc.end();
    let readTs = false;
    if (TS && !TS.pending) {
      enc.resolveQuerySet(TS.q, 0, 8, TS.res, 0);
      enc.copyBufferToBuffer(TS.res, 0, TS.read, 0, 64);
      readTs = true;
    }
    device.queue.submit([enc.finish()]);
    if (readTs) {
      TS.pending = true;
      TS.read.mapAsync(GPUMapMode.READ).then(() => {
        const v = new BigUint64Array(TS.read.getMappedRange());
        for (let i = 0; i < 4; i++) {
          const ms = Number(v[i * 2 + 1] - v[i * 2]) / 1e6;
          if (ms >= 0 && ms < 1000) TS.ms[i] = TS.ms[i] ? TS.ms[i] * 0.8 + ms * 0.2 : ms;
        }
        TS.read.unmap();
        TS.pending = false;
      }, () => { TS.pending = false; });
    }
  }

  // --- CDLOD node selection (CPU, allocation free) ---
  const ranges = new Float64Array(LODS);
  for (let l = 0; l < LODS; l++) ranges[l] = R0 * Math.pow(2, l);
  const planes = new Float64Array(16);
  const HB = 4.0;
  const XB = 4.0;
  let nodeCount = 0, ccx = 0, ccy = 0, ccz = 0;
  function sphereHit(x0, z0, size, r) {
    const dx = Math.max(x0 - ccx, 0, ccx - (x0 + size));
    const dz = Math.max(z0 - ccz, 0, ccz - (z0 + size));
    const dy = Math.max(-HB - ccy, 0, ccy - HB);
    return dx * dx + dy * dy + dz * dz <= r * r;
  }
  function inFrustum(x0, z0, size) {
    const minx = x0 - XB - ccx, maxx = x0 + size + XB - ccx;
    const minz = z0 - XB - ccz, maxz = z0 + size + XB - ccz;
    const miny = -HB - ccy, maxy = HB - ccy;
    for (let p = 0; p < 16; p += 4) {
      const a = planes[p], b = planes[p + 1], c = planes[p + 2], d = planes[p + 3];
      const px = a > 0 ? maxx : minx, py = b > 0 ? maxy : miny, pz = c > 0 ? maxz : minz;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  }
  function addNode(x0, z0, size, lod) {
    if (nodeCount >= MAX_NODES) return;
    const o = nodeCount * 4;
    instData[o] = x0; instData[o + 1] = z0; instData[o + 2] = size; instData[o + 3] = lod;
    nodeCount++;
  }
  function selectNode(x0, z0, size, lod) {
    if (!sphereHit(x0, z0, size, ranges[lod])) return false;
    if (!sphereHit(x0, z0, size, MAX_DIST) || !inFrustum(x0, z0, size)) return true;
    if (lod === 0 || !sphereHit(x0, z0, size, ranges[lod - 1])) { addNode(x0, z0, size, lod); return true; }
    const h = size * 0.5;
    for (let i = 0; i < 4; i++) {
      const nx = x0 + (i & 1) * h, nz = z0 + (i >> 1) * h;
      if (!selectNode(nx, nz, h, lod - 1)) {
        if (sphereHit(nx, nz, h, MAX_DIST) && inFrustum(nx, nz, h)) addNode(nx, nz, h, lod - 1);
      }
    }
    return true;
  }
  function selectAll() {
    nodeCount = 0;
    ccx = cam.x; ccy = cam.y; ccz = cam.z;
    const m = viewProj;
    for (let i = 0; i < 4; i++) {
      const r = i >> 1, s = (i & 1) ? -1 : 1;
      planes[i * 4] = m[3] + s * m[r];
      planes[i * 4 + 1] = m[7] + s * m[4 + r];
      planes[i * 4 + 2] = m[11] + s * m[8 + r];
      planes[i * 4 + 3] = m[15] + s * m[12 + r];
    }
    const top = LODS - 1;
    const ts = LEAF * Math.pow(2, top);
    const x0 = Math.floor((ccx - MAX_DIST) / ts), x1 = Math.floor((ccx + MAX_DIST) / ts);
    const z0 = Math.floor((ccz - MAX_DIST) / ts), z1 = Math.floor((ccz + MAX_DIST) / ts);
    for (let zi = z0; zi <= z1; zi++) {
      for (let xi = x0; xi <= x1; xi++) selectNode(xi * ts, zi * ts, ts, top);
    }
  }

  await device.queue.onSubmittedWorkDone();
  return {
    resize,
    render,
    get lost() { return lost; },
    get stats() { return { nodes: nodeCount, size: [W, H], gpuMs: TS ? { sim: TS.ms[0], skyEnv: TS.ms[1], ocean: TS.ms[2], post: TS.ms[3] } : null }; },
    // Forget the foam history (the next frame rebuilds it).
    resetFoam() { lastT = null; },
    destroy() { try { device.destroy(); } catch { /* already gone */ } },
  };
}
