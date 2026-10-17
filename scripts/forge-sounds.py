import sys, os
# Usage: EARSHOT_REPO=/path/to/earshot python scripts/forge-sounds.py  (numpy, scipy, soundfile only; no models)
REPO = os.environ['EARSHOT_REPO']
sys.path.insert(0, REPO)
import numpy as np, soundfile as sf
from scipy import signal
from earshot.forge import dsp
from earshot.forge.recipes import impact, whoosh

OUT = os.environ.get('SOUND_OUT', 'snd')
os.makedirs(OUT, exist_ok=True)
SR = dsp.SR
mono = lambda x: x.mean(axis=1) if x.ndim == 2 else x
def save(name, x, peak=-1.5):
    x = dsp.normalize(np.asarray(x, float), peak)
    sf.write(f'{OUT}/{name}.wav', x, SR)
    print(f'{name:10s} {len(x)/SR:5.2f}s peak {np.abs(x).max():.2f}')
def loop(x, xf=0.25):
    """seamless loop: cross-fade the end into the start"""
    n = dsp.n_of(xf); w = np.linspace(0, np.pi / 2, n)
    head = x[:n] * np.sin(w) + x[-n:] * np.cos(w)
    return np.concatenate([head, x[n:-n]])
def lp(x, f, order=2): return signal.sosfilt(signal.butter(order, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, order=2): return signal.sosfilt(signal.butter(order, f, 'high', fs=SR, output='sos'), x)
def bp(x, lo, hi, order=2): return signal.sosfilt(signal.butter(order, [lo, hi], 'band', fs=SR, output='sos'), x)

# 1. explosion: the cinematic 'deep' boom plus the struck-metal punch for the crack
r = dsp.rng(11)
deep = impact.recipe_for('impact', 'deep'); punch = impact.recipe_for('impact', 'punch')
a = mono(deep.render(dict(deep.DEFAULTS), r)); b = mono(punch.render(dict(punch.DEFAULTS), dsp.rng(5)))
n = min(len(a), len(b)); boom = a[:n] / np.abs(a[:n]).max() + 0.45 * b[:n] / np.abs(b[:n]).max()
boom = dsp.trim_tail(boom, -55)[: dsp.n_of(5.0)]
save('boom', dsp.fade(boom, 0.0, 0.5))

# 2. catapult clunk (steel cradle on its buffers): the short metal member, cut hard
m = impact.recipe_for('impact', 'metal')
c = mono(m.render(dict(m.DEFAULTS), dsp.rng(3)))[: dsp.n_of(0.9)]
save('clunk', dsp.fade(hp(c, 45), 0.0, 0.35))

# 3. pneumatic burst of the catapult: a sharp air release, thinning out
r = dsp.rng(21)
air = dsp.air(1.8, r, center=3200, lo_db=1.5, hi_db=1.0, flutter=0.25, rate=11, bright=0.85)
env = dsp.env_curve([(0, 0), (0.006, 1), (0.25, 0.55), (0.8, 0.2), (1.8, 0)], 1.8)
save('hiss', hp(air * env, 900))

# 4. missile launch: the 'big' whoosh (a heavy thing leaving) under an ignition crack
w = whoosh.recipe('big'); lw = mono(w.render(dict(w.DEFAULTS), dsp.rng(8)))
r = dsp.rng(31)
crack = dsp.noise(0.6, r) * dsp.env_curve([(0, 1), (0.03, 0.5), (0.6, 0)], 0.6)
lw = lw[: dsp.n_of(3.2)]
lw[: len(crack)] += 0.8 * np.abs(lw).max() * hp(crack, 600) / np.abs(crack).max()
save('launch', dsp.fade(lw, 0.0, 0.6))

# 5. splash: a slap of water plus bubbles that rise as they close
r = dsp.rng(41); T = 1.6; N = dsp.n_of(T); t = dsp.t_of(N)
slap = bp(dsp.noise(T, r), 500, 6500) * np.exp(-t / 0.18)
bub = np.zeros(N)
for _ in range(16):
    t0 = r.uniform(0.0, 0.7); f0 = r.uniform(450, 2400); tau = r.uniform(0.02, 0.07)
    k = dsp.n_of(0.3); tt = np.arange(k) / SR
    ph = 2 * np.pi * f0 * (tt + 0.35 * tt ** 2 / tau)
    s = int(t0 * SR); bub[s:s + k] += r.uniform(0.15, 0.5) * np.sin(ph)[: N - s] * np.exp(-tt / tau)[: N - s]
wash = lp(dsp.noise(T, r), 2500) * np.exp(-t / 0.5) * 0.4
save('splash', dsp.fade(slap + bub + wash, 0.0, 0.3))

# --- loops -----------------------------------------------------------------------------------------
# 6. drone engine: a small two-stroke. Firing pulses with jitter through exhaust resonances, prop flutter.
r = dsp.rng(51); L = 1.0; N = dsp.n_of(L); f0 = 90.0
pulses = np.zeros(N); period = SR / f0; k = 0.0
cnt = int(L * f0)
for i in range(cnt):
    pulses[int(i * period + r.uniform(-0.04, 0.04) * period) % N] += r.uniform(0.7, 1.0)
body = np.zeros(N)
for fc, q, g in ((190, 6, 1.0), (420, 8, 0.8), (870, 10, 0.5), (1700, 8, 0.25)):
    b_, a_ = signal.iirpeak(fc, q, fs=SR); body += g * signal.lfilter(b_, a_, pulses)
body += 0.5 * lp(pulses, 700)
t = dsp.t_of(N)
rough = 1 + 0.25 * np.sin(2 * np.pi * (f0 / 2) * t) + 0.12 * np.sin(2 * np.pi * 14 * t)
eng = np.tanh(2.2 * body / np.abs(body).max()) * rough
eng = eng + 0.15 * hp(dsp.noise(L, r), 2500) * (1 + 0.5 * np.sin(2 * np.pi * f0 * t))
save('engine', lp(eng, 6500))  # periodic over exactly L: loops without a seam
# 7. rocket motors: roaring broadband, crackle on top (booster: tighter and brighter; missile: bigger)
def motor(seed, L, center, crackle, low_cut):
    r = dsp.rng(seed)
    a = dsp.air(L, r, center=center, lo_db=3.0, hi_db=2.5, flutter=0.5, rate=9, bright=0.4)
    b = lp(dsp.noise(L, r, 'brown'), 260) * 3
    c = (r.random(dsp.n_of(L)) > 0.9985) * r.uniform(0.3, 1.0, dsp.n_of(L))
    c = hp(signal.fftconvolve(c, np.exp(-np.arange(300) / 30.0))[: dsp.n_of(L)], 1500)
    x = a + 0.9 * b + crackle * c * 6
    return hp(x, low_cut)
save('booster', loop(motor(61, 3.0, 1500, 1.2, 60)))
save('motor', loop(motor(71, 3.0, 800, 0.6, 35)))
# 8. ambient beds
r = dsp.rng(81)
save('wind', loop(dsp.air(7.0, r, center=520, lo_db=4.0, hi_db=3.5, flutter=0.8, rate=0.35, bright=0.5, whistle=0.08), 0.8))
save('surf', loop(lp(dsp.air(9.0, dsp.rng(91), center=260, lo_db=3, hi_db=5, flutter=0.9, rate=0.18, bright=0.2), 900), 1.0))
# 9. ship hum: engine fundamentals (whole cycles in the loop) over a low rumble
L = 2.0; N = dsp.n_of(L); t = dsp.t_of(N)
hum = np.sin(2 * np.pi * 52 * t) + 0.5 * np.sin(2 * np.pi * 104 * t + 1) + 0.6 * np.sin(2 * np.pi * 78 * t + 2) + 0.15 * np.sin(2 * np.pi * 156 * t)
rum = lp(dsp.noise(L, dsp.rng(101), 'brown'), 150) * 4
save('hum', loop(hum * 0.5 + rum, 0.3))
