import {
  scenario, ENGAGE, ENGAGE_DEFAULTS, ENGAGE_STORAGE_KEY, MAX_BURST, RANGE_LIMITS, previewEngagement, validateEngage,
} from './scenario.js';
import { stripShareParams } from './share.js';
import { toast } from './pathEditor.js';

// Engagement panel: when the missile leaves, when it bursts and how close to the
// drone. The guidance run is baked at load, so Apply stores the setting and reloads
// (and sessionStorage tells the next page to open a few seconds before the launch).
// While the panel is open, previewEngagement() reruns the simulation for the readout.

export const SEEK_KEY = 'intercept.seek';

const SIDE_HINT = {
  auto: 'The warhead goes off as soon as the missile is within this range of the drone, on whichever side it arrives.',
  above: 'The missile is steered to a point this far above the drone and bursts there.',
  below: 'The missile is steered to a point this far below the drone and bursts there.',
  left: 'The missile is steered to a point this far to the drone’s left and bursts there.',
  right: 'The missile is steered to a point this far to the drone’s right and bursts there.',
};

export function createEngagePanel({ onOpen, onClose }) {
  const $ = (s) => document.querySelector(s);
  const ui = {
    panel: $('#engage'), toggle: $('#btn-engage'), timing: $('#en-timing'), side: $('#en-side'),
    timeRow: $('#en-time-row'), rangeRow: $('#en-range-row'), range: $('#en-range'), rangeOut: $('#en-range-out'), timeLabel: $('#en-time-label'), time: $('#en-time'), timeOut: $('#en-time-out'),
    dist: $('#en-dist'), distOut: $('#en-dist-out'), hint: $('#en-side-hint'), bar: $('#en-bar'),
    launch: $('#en-launch'), flight: $('#en-flight'), impact: $('#en-impact'), verdict: $('#en-verdict'),
    apply: $('#en-apply'), reset: $('#en-reset'), cancel: $('#en-cancel'),
  };
  const enabled = scenario.hasMissile;
  if (ui.toggle) ui.toggle.hidden = !enabled;

  let active = false;
  let draft = { ...ENGAGE };
  let preview = null;
  let timer = 0;

  const f1 = (v) => v.toFixed(1);

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 50);
  }

  function refresh() {
    if (!active || !enabled) return;
    try { preview = previewEngagement(draft); } catch { preview = null; }
    paint();
  }

  function paint() {
    const p = preview;
    ui.timing.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.timing === draft.timing));
    ui.side.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.side === draft.side));
    ui.side.hidden = draft.dist <= 0;
    ui.hint.textContent = draft.dist <= 0
      ? 'Direct hit: the missile flies into the drone.'
      : SIDE_HINT[draft.side];

    ui.timeRow.hidden = draft.timing === 'auto' || draft.timing === 'range';
    ui.rangeRow.hidden = draft.timing !== 'range';
    ui.rangeOut.textContent = `${draft.range} m`;
    ui.range.value = draft.range;
    ui.timeLabel.textContent = draft.timing === 'impact' ? 'Impact time' : 'Launch time';
    ui.timeOut.textContent = `${f1(draft.time)} s`;
    ui.time.value = draft.time;
    ui.distOut.textContent = draft.dist <= 0 ? 'Direct hit' : `${draft.dist} m`;
    ui.dist.value = draft.dist;

    if (!p) return;
    ui.time.min = draft.timing === 'impact' ? Math.round(p.tMin + 1) : p.tMin.toFixed(1);
    ui.time.max = p.tMax.toFixed(1);
    ui.launch.textContent = `${f1(p.tLaunch)} s`;
    ui.flight.textContent = `${f1(p.tHit - p.tLaunch)} s`;
    ui.impact.textContent = `${f1(p.tHit)} s`;
    const end = Math.max(p.tMax, p.tHit) + 2;
    ui.bar.style.setProperty('--a', `${(p.tLaunch / end) * 100}%`);
    ui.bar.style.setProperty('--b', `${(p.tHit / end) * 100}%`);
    ui.bar.style.setProperty('--auto', `${(p.autoLaunch / end) * 100}%`);
    const warn = !p.reached
      ? 'The missile cannot reach the drone from this launch; the hit would be forced. Pick another trigger.'
      : draft.timing === 'range' && !p.rangeOk
        ? `The drone never closes in from beyond ${draft.range} m on its inbound run, so this is the closest match. Try a smaller distance.`
      : draft.timing === 'impact' && Math.abs(p.tHit - draft.time) > 0.25
        ? `Impact cannot be moved all the way to ${f1(draft.time)} s: the earliest or latest launch gives ${f1(p.tHit)} s.`
        : '';
    ui.verdict.textContent = warn;
    ui.verdict.hidden = !warn;
  }

  function setTiming(timing) {
    // Start each trigger from what the scene does now, so switching changes nothing yet.
    const from = preview ?? { tLaunch: scenario.tLaunch, tHit: scenario.tHit, launchRange: null };
    if (timing !== draft.timing) {
      draft.time = timing === 'impact' ? from.tHit : from.tLaunch;
      if (timing === 'range' && from.launchRange) {
        draft.range = Math.min(Math.max(Math.round(from.launchRange / 10) * 10, RANGE_LIMITS[0]), RANGE_LIMITS[1]);
      }
    }
    draft.timing = timing;
    draft.time = Math.round(draft.time * 10) / 10;
    paint();
    schedule();
  }

  function apply() {
    const clean = validateEngage(draft);
    if (!clean) { toast('Those settings are not valid.'); return; }
    const isDefault = JSON.stringify(clean) === JSON.stringify(ENGAGE_DEFAULTS);
    try {
      if (isDefault) localStorage.removeItem(ENGAGE_STORAGE_KEY);
      else localStorage.setItem(ENGAGE_STORAGE_KEY, JSON.stringify(clean));
      sessionStorage.setItem('intercept.skip', '1'); // reload straight back into the scene
      sessionStorage.setItem(SEEK_KEY, String(Math.max(0, (preview?.tLaunch ?? scenario.tLaunch) - 4)));
    } catch {
      toast('Could not save the settings (browser storage is blocked).');
      return;
    }
    stripShareParams();
    location.reload();
  }

  const api = {
    get active() { return active; },
    toggle() { api.active ? api.close() : api.open(); },
    open() {
      if (active || !enabled) return;
      active = true;
      draft = { ...ENGAGE };
      ui.time.min = '0';
      ui.time.max = '300';
      ui.range.min = String(RANGE_LIMITS[0]);
      ui.range.max = String(RANGE_LIMITS[1]);
      ui.dist.max = String(MAX_BURST);
      ui.panel.hidden = false;
      ui.toggle?.classList.add('active');
      onOpen?.();
      paint();
      refresh();
    },
    close() {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      ui.panel.hidden = true;
      ui.toggle?.classList.remove('active');
      onClose?.();
    },
  };

  if (enabled) {
    ui.toggle?.addEventListener('click', () => api.toggle());
    ui.timing.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-timing]');
      if (b) setTiming(b.dataset.timing);
    });
    ui.side.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-side]');
      if (b) { draft.side = b.dataset.side; paint(); schedule(); }
    });
    ui.range.addEventListener('input', () => { draft.range = parseInt(ui.range.value, 10); paint(); schedule(); });
    ui.time.addEventListener('input', () => { draft.time = parseFloat(ui.time.value); paint(); schedule(); });
    ui.dist.addEventListener('input', () => { draft.dist = parseInt(ui.dist.value, 10); paint(); schedule(); });
    ui.reset.addEventListener('click', () => { draft = { ...ENGAGE_DEFAULTS }; paint(); refresh(); });
    ui.apply.addEventListener('click', apply);
    ui.cancel.addEventListener('click', () => api.close());
  }
  return api;
}
