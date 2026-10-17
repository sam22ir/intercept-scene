# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Interactive Three.js scene: an orange target drone is launched off a steep side rail (24°) with a rocket booster under its tail, on a steaming stealth frigate (C28A style, pennant 920). It flies a loop, makes a low close pass along the port side, climbs out slowly ahead, then turns back for an inbound run at the ship. On that run, a missile from the frigate's forward box launcher shoots it down. The user can scrub time forwards and backwards and click the drone, missile or ship to focus the camera on it. Vanilla JS (ES modules), Vite, `three@0.186.1`. No tests, no linter.

The folder name ends with a **trailing space** (`/home/saadi/plane sceen `). Quote every path in shell commands.

## Commands

```bash
pnpm install      # one install at a time on this machine
pnpm dev          # http://localhost:5173 (also the "dev" entry in .claude/launch.json)
pnpm build        # dist/ bundle + dist/intercept-offline.html (the >500 kB chunk warning is three.js, expected)
pnpm cf-deploy    # build + `wrangler deploy` (static-assets Worker, see wrangler.jsonc)
```

`scripts/build-offline.mjs` runs after `vite build`. It inlines the single JS bundle and the CSS into `dist/intercept-offline.html`, which opens by double-click from disk with no internet. The site links to it ("Download offline version", `#dl-offline`), and the script strips that link from the offline copy. Keep the app free of runtime network loads (fonts, CDN scripts, fetched assets) and of code splitting, or the offline file breaks. The script fails the build if it finds more than one bundle.

Live at https://intercept-scene.nafaa-store.workers.dev. Deploying is public, so ask before running it.

`src/scenario.js` imports only `three`, so timings and clearances can be checked in Node without a browser. Import it and sample `planeRelPos`, `missilePos` and `shipPos`.

To test in a real browser when the built-in preview is unavailable, drive headless Chromium with `playwright-core` (installed under `/mnt/hdd/ai/ai-agent-board/node_modules`, Chromium under `~/.cache/ms-playwright/chromium-1243`) with the flags `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --no-sandbox`. Serve `dist/` with `python3 -m http.server`, or open `dist/intercept-offline.html` as `file://`. Software rendering is slow (about 10 s to start, 1-2 fps), so seek with `__scene.clock.seek(t)` instead of waiting for real-time playback. Also test the offline file inside an `<iframe sandbox="allow-scripts">` and with `--disable-3d-apis`.

In the browser console, `window.__scene` exposes `{ scenario, clock, setFocus, camera, controls, rig, renderer, plane, missile, ship }`, for example `__scene.clock.seek(__scene.scenario.tHit)`.

## Missions

The start screen also picks the mission (`?mode=intercept|chute`, or `globalThis.__SCENARIO` set by `start.js`, read once at import like the ship variant):
- **`intercept`**: the missile shoots the drone down on its inbound run, as described below.
- **`chute`** (recovery): the missile is never fired and nothing is hit. At the end of the planned path (`T_CHUTE`) the engine cuts and the drone opens an orange parachute, descends and lands in the sea.

In recovery mode `tLaunch` and `tHit` are `Infinity` so every `t < tHit` check stays true. The missile simulation, debris, fireball and launcher aiming are skipped (`scenario.hasMissile` is false, `debris` is `null` in `main.js`, and the missile focus button is disabled). Code that loops up to `tHit` must use `scenario.tChute` instead (see `tFlightEnd` in `effects.js`). The default path is the intercept path cut at the middle of the inbound run, and a custom path is stored under its own key (`intercept.path.chute.v1`).

## Ship variants

The player picks a frigate on a start screen (`#chooser` in `index.html`, driven by `src/start.js`, the real entry point):
- **`fwd`**, pennant 920: launcher on the forward deckhouse roof (the original fit).
- **`aft`**, pennant 921: launcher on the aft end of the hangar roof (it replaces the CIWS there), lofting steeply over the radome and mast.

The choice reaches `scenario.js` through `globalThis.__SHIP_VARIANT` (set by `start.js` just before the lazy `import('./main.js')`) or, for deep links, `?ship=fwd|aft`. It is read **once at import time**, so switching ship means a fresh page load: "Change ship" sets a `sessionStorage` flag and reloads so the chooser shows again. Picking a ship does **not** navigate or reload, because navigation fails in sandboxed file viewers and previews. `start.js` also shows a loading screen while the scene builds and an on-screen error box (with a WebGL hint) if start-up or rendering throws. Never touch `localStorage` or `sessionStorage` outside `try`: even naming them throws in blocked-storage and sandboxed contexts (use the `read`/`write` helpers in `start.js`). `main.js` is imported lazily, so `vite.config.js` sets `codeSplitting: false` to keep a single JS bundle for the offline file. Both variants share the drone path, so `tLaunch` and the hit are identical. The aft fit differs in its pivot, stow yaw (facing the stern), a steeper aim pitch and a short pitch-over guidance phase after launch. To check a variant in Node, set `globalThis.__SHIP_VARIANT = 'aft'` before importing `scenario.js`.

## Architecture

**Core rule: every visual and every sound is a pure function of the sim time `t`.** Nothing accumulates per-frame state, which is what makes reverse playback and scrubbing work. Any new animation must be computable from `t` alone, including flicker, strobes and flag ripple. A stateful update breaks scrubbing (check by jumping to the end, then back to 0).

### `src/scenario.js`

Holds the story, all timing and every ship mount point. Units are metres. The bow points +X, +Y is up, starboard is +Z. Model noses point along local +Z.

- **Moving ship frame**: the ship moves at constant `SHIP_SPEED`, and `shipPos(t)` is a pure translation, with no roll or pitch. The catapult `RAIL`, `LAUNCHER_PIVOT`/`TUBE_MOUTH` and `deckHeight(x)` are defined in the ship frame. `ship.js` builds its geometry from these same constants, so move a mount here, not in the model.
- **Drone path**:
  - On the rail, the drone strokes in closed form. The booster burns from `tBoost0` (cradle starts moving) to `tBoost1` (1.2 s after release), and the plane model hides the canister shortly after (`plane.setBooster(t, …)`).
  - After release it follows a Catmull-Rom curve in the **ship frame** (`planeRelPos`), driven by a relative-airspeed profile through a precomputed arc-length table. `planePos` adds `shipPos`.
  - The first waypoint and tangent are derived from the rail-end pose, so the release is continuous.
  - Attitude follows the *relative* path; bank comes from turn rate.
- **Recovery descent** (`CHUTE_MODE`): after `T_CHUTE` the drone follows a closed-form world-frame descent. The horizontal speed bleeds off into a breeze, the vertical speed settles to a 5.4 m/s sink rate, and `T_SPLASH` is found by bisection. The attitude blends from the path's last attitude to a swinging hang, then a floating list. `planePose`, `planeRelPos` and `propAngle` switch to it automatically.
- **Editable path**: the first two waypoints (`PATH_FIXED`) come from the catapult; everything after is `DEFAULT_PATH`, or a custom path from `localStorage['intercept.path.v1']` (`{points: [[x, alt, z], …]}`, validated by `validatePath`, altitude floor `MIN_ALT`). It is read **once at import**, so the path editor applies a change by saving and reloading.
- **Derived events**: everything is measured in the ship frame, so any path works:
  - `tLaunch` is the first moment the drone, having left `LAUNCH_RANGE`, closes back inside it. If it never leaves, launch is at the first closing moment after 8 s. If it never closes, launch is near the path's end.
  - Timeline markers "Turn back", "Close pass" and "Inbound run" come from prominent local maxima and minima of the range to the ship. They are not hard-coded.
  - `scenario.interceptMiss` is how far short the missile was before the hit is snapped on. The UI warns when it is large.
- **Missile**:
  - Proportional navigation is **simulated once at module load** into a fixed-rate sample table, starting from the tube mouth at `tLaunch` along the tube direction.
  - The last sample is snapped onto the drone, so the hit is exact. `tHit` is an output of that sim.
  - The launcher's slew (`launcherAim(t)`: stowed → aimed → stowed) is a pure function of `t`.
  - The drone is shot down on its **inbound run** (coming back at the ship), never while flying away. `tInbound` is the farthest point after the close pass, and `tLaunch` is derived as the moment the inbound drone closes inside `LAUNCH_RANGE`.
  - The inbound run comes from ahead of the bow, so the forward launcher's missile clears the superstructure in its first second. Keep it that way if you change the path.

### Rendering and timeline

- `src/main.js` holds `applyTime(t)`, which poses everything for a given `t`, plus focus targets, picking and the render loop. `scenario.tEnd` is set here from the debris fall time. There is deliberately **no bloom pass**: the `Sky` shader outputs HDR values far above any usable threshold, so bloom turned the whole frame milky. Glow comes from additive sprites (flash, exhaust) instead.
- `src/labels.js` holds the floating tags (a `CSS2DRenderer` layer over the canvas, click-through) for the drone, missile and ship, plus the missile trajectory line. The line has two geometries sharing one position buffer: solid up to `t`, dashed for the rest. `main.js` feeds it per-frame data from `applyTime`. The Labels button and the **L** key turn it all off, and the choice is kept in `localStorage`.
- `src/pathEditor.js` is the path editor (button, **E** key). It pauses at t = 0 and shows the path as a cyan spline with draggable handles, altitude stems and a sea shadow, all in a group that follows the ship. Tools:
  - **Move**: drag a dot, double-click the line to add a point, Delete removes one, ↑/↓ change altitude.
  - **Draw**: freehand strokes on the sea at a chosen altitude, right-drag to orbit.
  - Copy and Paste as JSON, Default, Clear.

  Edits are only a preview until "Apply & play", which stores them and reloads. Pointer handlers are registered on `window` in the capture phase so a handle drag never reaches OrbitControls. The editor's logic can be driven in Node with a stand-in DOM.
- `src/timeline.js` holds the master clock (`t`, play direction, speed) and the playback bar, markers and keys. The clock is the only source of time.

### Director camera and sound

- **`src/director.js`** is the cinematic camera (Director button, **D** key, `?cam=director`). Each shot is a pure function of `t` that places the camera and its look-at point, so cuts land on the same frames when scrubbing or playing backwards. The shot list is derived from `scenario` times (catapult, chase, low close pass found by the "Close pass" event, launcher, missile ride, wide impact, splash; recovery swaps the last three for a parachute orbit and splash). A shot shorter than `MIN_SHOT` is dropped, so custom paths still get sensible cuts. It needs `dronePos(t, out)` to resolve to the wreck after impact (`dronePosAt` in `main.js`) and `tWater`.
- While directing, `main.js` bypasses `rig` and OrbitControls (`controls.enabled = false`; the polar limit would clamp the low shots) and sets the camera itself. Every manual camera input goes through `setFocus`, which ends the Director first and aims the orbit target level with the camera so there is no jump. Internal shot changes never call `setFocus`. Keep the field of view at 50: `pointScale` is only recomputed in `resize()`. Shot times can be checked in Node by standing in for `dronePos`.
- **`src/audio.js`** plays sound effects generated with the ElevenLabs connector (text-to-sound v2, prompts: one concrete sound each). `scripts/build-sounds.py DIR` (numpy, scipy, soundfile, ffmpeg) normalises them, turns the loops into seamless cross-faded PCM wavs (an mp3 loop can click at its encoder padding), and writes the base64 `src/audioAssets.js`, so the offline file needs nothing else. Loops (engine, motors, wind, surf, hum) run continuously; each frame the gain, low-pass, pan and playback rate (prop pitch, Doppler from analytic velocities, never frame deltas) are set from `t` and the camera. One-shots (catapult burst and clunk, launch, explosion, splashes) start at the sample offset `t - tEvent` and re-sync when time jumps; they play only while the clock runs forward. It is silent while time stands still. The context starts on the first user gesture (Sound button or **S** key; the choice is kept in `localStorage`). `window.__scene.audio.state` / `.loaded` report the context and decoded samples.

### Models

`src/models/` contains procedural geometry only, with **no external textures or assets**. Canvas textures are generated at load.

- **`kit.js`**: `Kit` collects parts per material and merges them, which keeps the detailed ship at a few dozen draw calls. Add new detail through a Kit, not as loose meshes. `hexa` builds sloped stealth blocks and auto-orients face winding. `slab` and `facePanel` place windows, doors and panels on sloped faces.
- **`ship.js`**:
  - The launcher stand and the pennant text depend on `SHIP_VARIANT` and `PENNANT`.
  - The hull is lofted from per-level lines (keel, bilge, waterline, knuckle, deck) with raked stems. Each level pair is a separate strip, so creases stay sharp.
  - Hull UVs flip *u* on the port side, and port and starboard use different halves of the texture, so the painted "920" reads correctly on both sides.
  - The animated parts are the radar, launcher yaw/pitch, tube cap, catapult cradle and flag.
  - The catapult follows the reference photos: a bent stainless blast plate, angle-iron base frame, ladder-frame beam on tubular A-frame legs, rust-brown pivot ears, hydraulic strut, tie-down chains to deck sockets, plus a battery box and flight case. The ears sit outboard of the drone's body (|z| 0.62) and behind its wing, and the gas bottle and buffers keep a gap from it. After changing the rail pitch, length or ride height, re-check clearances by sampling `planePose` in the rail frame, as the Node check did.
  - Ship pick boxes live inside the ship group.
- **`parachute.js`** (recovery only): a 24-gore orange canopy with suspension lines and a pilot chute. Everything is a function of `t` and the drone's pose: lines pay out, the canopy streams then inflates, and after splashdown it collapses flat on the water downwind. The lines and pilot chute live in world space, and only the canopy has its own transform.
- **`plane.js`**:
  - The fuselage and flying surfaces are lofted from rounded-rect and airfoil sections. Stations are evenly spaced, so painted detail isn't stretched.
  - The **direct children of `plane.group` are the debris pieces**: fuselage, wingL, wingR, tail, prop. Nest new detail inside them, or each addition becomes its own falling piece with its own splash.
  - Side lettering is drawn rotated ±90° in the canvas so it reads correctly from each side.
- **`environment.js`**:
  - `Sky`, also used as the PMREM environment.
  - Sun shadow frustum that follows the focus.
  - Sprite clouds.
  - Analytic ocean shader whose wave normals are driven by `t`. Its wake foam (bow wave, stern wake, Kelvin arms) reads `uShipX`, and `hullHalf()` there mirrors `widthFactor()` in `ship.js`.

### Effects, camera and picking

- **`src/fx/particles.js`** is a `ParticleField`. Each particle's position and colour are closed-form in `uTime - birth`, with all births baked at load.
- **`src/fx/effects.js`**:
  - **Debris**: closed-form linear-drag ballistics from each part's pose at `tHit`, then the parts sink.
  - **Recovery**: a puff as the pilot chute pops, then at splashdown a spray burst and an expanding foam ring.
  - **Particle bake**: booster plume and deck blast, drone exhaust haze, launch backblast, missile trail, fireball, burning smoke and splashes. Anything emitted from the ship must add the ship's velocity.
- **`src/cameraRig.js`** eases to a target, then carries the camera by the target's per-frame delta. Focus targets always resolve to a position:
  - The missile sits at its tube before launch, and the blast point after.
  - The drone hands over to its falling fuselage after impact.
  - Focus switches from the missile to the wreck at `tHit`.
- **Picking**: drone and missile pick spheres grow with camera distance and win over the ship's boxes.
