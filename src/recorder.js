// Real-time video capture of the canvas (plus the scene audio) with MediaRecorder.
// It does not render offline: the scene plays at 1x with the Director camera and the
// browser records whatever frames it manages to draw. Nothing downloads by itself;
// the finished file is offered as an <a download> link.

const NOTE = 'Real-time capture: the video is recorded while the scene plays, so it can be choppy, and on a slow machine it may run slower than real time. '
  + 'Tags, captions and the HUD are not in the video. Keep this tab visible. Sound must be on for audio.';

function pickMime(withAudio) {
  const list = [
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8',
    'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
  ];
  const ok = list.filter((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } });
  const audioOk = ok.filter((m) => /opus|mp4a/.test(m) || !m.includes('codecs'));
  return (withAudio ? audioOk[0] : null) ?? ok.find((m) => !/opus|mp4a/.test(m)) ?? ok[0] ?? '';
}

export function createRecorder({
  canvas, clock, scenario, audio, setDirector, isDirecting, isBusy,
}) {
  const button = document.querySelector('#btn-record');
  const box = document.querySelector('#rec-box');
  const status = box.querySelector('.rec-status');
  const link = box.querySelector('.rec-link');
  const closeBtn = box.querySelector('.rec-close');
  box.querySelector('.rec-note').textContent = NOTE;

  const supported = typeof globalThis.MediaRecorder === 'function' && typeof canvas.captureStream === 'function';
  if (!supported) {
    button.disabled = true;
    button.title = 'Video recording is not available in this browser or embedded view (needs MediaRecorder and canvas capture)';
    return { supported: false };
  }
  button.title = 'Record the cinematic cut as a video file (real-time capture)';

  let rec = null;
  let chunks = [];
  let raf = 0;
  let url = null;
  let mime = '';
  let restoreDirector = false;
  let stopping = false;

  const show = (text) => { box.hidden = false; status.textContent = text; };
  const clearLink = () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
    link.hidden = true;
    link.removeAttribute('href');
  };
  const setButton = (on) => {
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? '⏹ Stop' : '⏺ Record';
  };

  function tickUi() {
    if (!rec) return;
    window.__scene?.invalidate?.(); // never let idle rendering skip a recorded frame
    show(`● Recording ${clock.t.toFixed(1)} / ${scenario.tEnd.toFixed(1)} s`);
    if (clock.t >= scenario.tEnd - 0.02 || !clock.playing) {
      // The clock stops by itself at the end; a pause by the user also ends the take.
      stop();
      return;
    }
    raf = requestAnimationFrame(tickUi);
  }

  function finish() {
    cancelAnimationFrame(raf);
    const type = rec?.mimeType || mime || 'video/webm';
    const blob = new Blob(chunks, { type });
    rec = null;
    chunks = [];
    stopping = false;
    setButton(false);
    if (restoreDirector) setDirector(false);
    if (!blob.size) { show('Recording produced no data.'); return; }
    url = URL.createObjectURL(blob);
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    link.href = url;
    link.download = `intercept-${scenario.mode}.${ext}`;
    link.textContent = `Download ${link.download} (${(blob.size / 1048576).toFixed(1)} MB)`;
    link.hidden = false;
    show('Recording ready.');
    window.__recordedBlob = blob; // inspection handle
  }

  function stop() {
    if (!rec || stopping) return;
    stopping = true;
    clock.playing = false;
    try { rec.stop(); } catch { finish(); }
  }

  function start() {
    if (isBusy?.()) { show('Close the path editor before recording.'); return; }
    clearLink();
    chunks = [];
    let stream;
    try {
      stream = canvas.captureStream(30);
      const audioStream = audio.getCaptureStream?.();
      audioStream?.getAudioTracks().forEach((tr) => stream.addTrack(tr));
      mime = pickMime(stream.getAudioTracks().length > 0);
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    } catch (err) {
      rec = null;
      show(`Could not start recording: ${err?.message ?? err}`);
      return;
    }
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = finish;
    rec.onerror = () => { show('Recording failed.'); stop(); };

    restoreDirector = !isDirecting();
    setDirector(true);
    const speed = document.querySelector('#speed');
    if (speed) speed.value = '1';
    clock.speed = 1;
    clock.direction = 1;
    clock.seek(0);
    clock.playing = true;
    rec.start(1000);
    setButton(true);
    show('● Recording 0.0 s');
    raf = requestAnimationFrame(tickUi);
  }

  button.addEventListener('click', () => { if (rec) stop(); else start(); });
  closeBtn.addEventListener('click', () => { if (rec) return; clearLink(); box.hidden = true; });

  return { supported: true, get recording() { return !!rec; }, start, stop };
}
