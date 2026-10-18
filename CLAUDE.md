# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Interactive Three.js scene: an orange target drone is launched off a side rail (18°) with a rocket booster under its tail, on a steaming stealth frigate (C28A style, pennant 920). It flies a loop, makes a low close pass along the port side, climbs out slowly ahead, then turns back for an inbound run at the ship. On that run, a missile from the frigate's forward box launcher shoots it down. The user can scrub time forwards and backwards and click the drone, missile or ship to focus the camera on it. Vanilla JS (ES modules), Vite, `three@0.186.1`. Node regression tests for `scenario.js` (`pnpm test`, also run by `pnpm build`); no linter.

The folder name ends with a **trailing space** (`/home/saadi/plane sceen `). Quote every path in shell commands.

## Commands

```bash
pnpm install      # one install at a time on this machine
pnpm dev          # http://localhost:5173 (also the "dev" entry in .claude/launch.json)
pnpm test         # node --test: scenario timings, hits, clearances, determinism
pnpm build        # tests + dist/ bundle + dist/intercept-offline.html (the >500 kB chunk warning is three.js, expected)
pnpm cf-deploy    # build + `wrangler deploy` (static-assets Worker, see wrangler.jsonc)
```

`scripts/build-offline.mjs` runs after `vite build`. It inlines the single JS bundle and the CSS into `dist/intercept-offline.html`, which opens by double-click from disk with no internet. The site links to it ("Download offline version", `#dl-offline`), and the script strips that link from the offline copy. Keep the app free of runtime network loads (fonts, CDN scripts, fetched assets) and of code splitting, or the offline file breaks. The script fails the build if it finds more than one bundle.

Live at https://intercept-scene.nafaa-store.workers.dev. Deploying is public, so ask before running it.

`src/scenario.js` imports only `three`, so timings and clearances can be checked in Node without a browser. Import it and sample `planeRelPos`, `missilePos` and `shipPos`.

To test in a real browser when the built-in preview is unavailable, drive headless Chromium with `playwright-core` (installed under `/mnt/hdd/ai/ai-agent-board/node_modules`, Chromium under `~/.cache/ms-playwright/chromium-1243`) with the flags `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --no-sandbox`. Serve `dist/` with `python3 -m http.server`, or open `dist/intercept-offline.html` as `file://`. Software rendering is slow (about 10 s to start, 1-2 fps), so seek with `__scene.clock.seek(t)` instead of waiting for real-time playback. Also test the offline file inside an `<iframe sandbox="allow-scripts">` and with `--disable-3d-apis`.

In the browser console, `window.__scene` exposes `{ scenario, clock, setFocus, camera, controls, rig, renderer, plane, missile, ship }`, for example `__scene.clock.seek(__scene.scenario.tHit)`.

## Missions

The start screen also picks the mission (`?mode=intercept|chute|pair`, or `globalThis.__SCENARIO` set by `start.js`, read once at import like the ship variant):
- **`intercept`**: the missile shoots the drone down on its inbound run, as described below.
- **`chute`** (recovery): the missile is never fired and nothing is hit. At the end of the planned path (`T_CHUTE`) the engine cuts and the drone opens a red square parachute, descends and lands in the sea.

- **`pair`** ("Two drones"): a second drone leaves the same rail `PAIR_DT` (14 s) after the first, on a wider, higher variant of the path (`pairVariant`), and a second missile is fired at it from the next launcher cell. Timing was chosen by sampling the minimum drone separation (about 125 m); the first drone's close pass at about 23 s sits right next to the rail, so a `PAIR_DT` of about 17 to 27 s (sampled: 6 m at 18, about 33 m at 24 and 26) brings the drones within tens of metres. Drone 2 is hidden until the cradle is home (`drones[1].tLoad`). `scenario.engagements` (length 0 in chute, 1 in intercept, 2 in pair) and `scenario.drones` hold the per-missile and per-drone timings, and `tLaunch`/`tHit` stay the first engagement. `planePos/planePose/planeVel/propAngle/missilePos/missilePose/tubeMouth` take an optional last argument `k` (0 or 1). The PN sim is `engage(k, tLaunch)`, and `launcherAim` slews stowed, aim 1, aim 2, stowed. Everything for drone 2 is built by `src/pair.js` (second plane and missile, plus `createDebris(plane, k)` and `createEffects(scene, debris, k)`). Extra camera buttons and keys: Drone 2 (**4**), Missile 2 (**5**). The Director only frames the first engagement; the HUD debrief lists both.

In recovery mode `tLaunch` and `tHit` are `Infinity` so every `t < tHit` check stays true. The missile simulation, debris, fireball and launcher aiming are skipped (`scenario.hasMissile` is false, `debris` is `null` in `main.js`, and the missile focus button is disabled). Code that loops up to `tHit` must use `scenario.tChute` instead (see `tFlightEnd` in `effects.js`). The default path is the intercept path cut at the middle of the inbound run, and a custom path is stored under its own key (`intercept.path.chute.v1`).

## Engagement settings

The missile engagement can be tuned from the ⋯ menu → Missile engagement (key **G**, `src/engagePanel.js`). The setting is `{timing, time, dist, side}`, stored in `localStorage['intercept.engage.v1']` (or `globalThis.__ENGAGE`, used by tests), read **once at import** like the path, and applied by reloading (the panel's Apply & replay also sets `sessionStorage['intercept.seek']` so the next page opens 4 s before launch, playing). It does nothing in the recovery mission.
- `timing` picks one launch trigger: `auto` (derived launch, the default), `launch` (missile leaves at `time`), `impact` (`solveLaunchForImpact` steps the launch time by the remaining error until the burst lands at `time`) or `range` (`launchAtRange`: the first moment the drone, having been farther out, closes to `range` metres of the ship, 100 to 1500; `auto` is the same search at `LAUNCH_RANGE` = 650). `previewEngagement` reports `rangeOk: false` when the path never closes in from that far. Only drone 1's shot moves in pair mode; shot 2 keeps `MIN_LAUNCH_GAP`.
- `dist` (0 to `MAX_BURST` = 60 m) and `side`: 0 is a direct hit (last missile sample snapped onto the drone). With `side: 'auto'` the warhead fuzes when the missile first comes within `dist` of the drone, on whichever side it arrives. With `above|below|left|right` the missile is guided to a point `dist` away from the drone in its velocity frame (right = velocity x up), and the last sample is snapped onto that point. `engage(k, tLaunch, opts)` returns `burstDist`, and `scenario.hitPos` is the burst point, so the fireball, flash, light and boom sit there, not on the drone. `createDebris` (`fx/effects.js`) throws each part away from the burst point when `burstDist > 0.5`, harder the closer it was.
- `previewEngagement(opts)` reruns one engagement without baking it, for the panel's live launch/flight/impact readout. The HUD debrief shows "Direct hit" or "Burst N m away".

## Ship variants

The player picks a mission and a frigate on a start screen (`#chooser` in `index.html`, driven by `src/start.js`, the real entry point). Both are radio groups (`[data-mode]`, `[data-ship]` with `aria-checked`): a click or a key (M, 1/2, arrows) only selects, hover is visual only, and the Start button, Enter or a double click launches. `launch()` runs at most once. The screen fits 1092×598 without scrolling; on phones the Start bar is sticky at the bottom (portrait stacks everything, landscape puts missions left and ships right). The `.chooser` grid centres with `margin: auto` on `.chooser-inner`, so tall content scrolls instead of being clipped at the top. Nothing inside the chooser may use `.panel` (hidden before `body.playing`).
- **`fwd`**, pennant 920: launcher on the forward deckhouse roof (the original fit).
- **`aft`**, pennant 921: launcher on the aft end of the hangar roof (it replaces the CIWS there). It fires astern: its drone makes the final inbound run from behind the ship.

The choice reaches `scenario.js` through `globalThis.__SHIP_VARIANT` (set by `start.js` just before the lazy `import('./main.js')`) or, for deep links, `?ship=fwd|aft`. **The page always opens on the start screen**: a `?ship=` / `?mode=` in the URL only preselects the choices. `start.js` goes straight into the scene only for a link that carries a moment (`?t`, `?focus`, `?cam`, `#path=`), for `?start=1` (use it for scripted or headless runs, e.g. `?ship=fwd&mode=intercept&start=1`), and after the app's own reloads (path editor Apply / Restore and engagement Apply set `sessionStorage['intercept.skip']`, which `start.js` reads once). Reloading by hand therefore returns to the start screen. It is read **once at import time**, so switching ship means a fresh page load: "Change ship" sets a `sessionStorage` flag and reloads so the chooser shows again. Picking a ship does **not** navigate or reload, because navigation fails in sandboxed file viewers and previews. `start.js` also shows a loading screen while the scene builds and an on-screen error box (with a WebGL hint) if start-up or rendering throws. Never touch `localStorage` or `sessionStorage` outside `try`: even naming them throws in blocked-storage and sandboxed contexts (use the `read`/`write` helpers in `start.js`). `main.js` is imported lazily, so `vite.config.js` sets `codeSplitting: false` to keep a single JS bundle for the offline file. **Firing arc rule**: each box only engages a drone ahead of or abeam its pivot (`fwd`) or astern of or abeam it (`aft`), so a missile never crosses the ship (`inArc` in `deriveLaunch`; a test samples the missile in the ship frame). The variants therefore have different default paths: they share the release, loop and close pass, then `INTERCEPT_PATH_AFT` swings round the bow and comes back inbound from astern (a hit about 540 m astern, launch near 68 s; `fwd` launches near 47 s). Recovery uses the forward path for both ships. Custom paths are stored per ship (`intercept.path.aft.v1`, `intercept.path.pair.aft.v1`), and a custom path that never gets in arc falls back to the old launch times. The aft fit differs in its pivot and stow yaw (facing the stern); `launcherAim` unwraps each aim yaw so the slew takes the short way round. To check a variant in Node, set `globalThis.__SHIP_VARIANT = 'aft'` before importing `scenario.js`.

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
- **Attitude limits**: the drone never rolls past `MAX_BANK` (50°, a hard clamp in `pathPose`) nor pitches past `MAX_PITCH` (20°). Bank follows `atan(v·ω / g)`, so the default paths are built from straights and constant-radius left arcs (R = 190 m) and the cruise speeds in `SPEED_KEYS` are kept near 36 to 42 m/s (the arcs reach about 47° of bank, 49.6° at the worst joint). The rail is 18° because the spline blend after release overshoots it by about 1° (19.0° measured). Tighter turns or faster cruising break `test/attitude.test.mjs`. The default arrays were generated by a small script (loop exit 40 m abeam, an inbound run starting about 720 m out, aimed at the ship), so edit them as data, or regenerate rather than nudge points.
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
  - The `fwd` inbound run comes from ahead of the bow and the `aft` one from astern, so each launcher's missile leaves away from the ship. Keep it that way if you change a path.

### Rendering and timeline

- **Idle rendering and quality** (`main.js`): the loop always runs, but `renderer.render`/`labels.render` are skipped unless clock.t, the camera matrix (1e-5 tolerance), `rig.id`, the Director shot or the `invalidate()` counter changed (window capture-phase pointer/wheel/key/click/resize and every UI toggle bump it; the path editor always renders). `__scene.renderCount` counts drawn frames. Adaptive quality (`high`/`medium`/`low`, `?quality=` pins it, `__scene.quality`) is decided once from frame times between consecutive drawn frames, with at most one later step down; low halves the particles through `ParticleField.setDensity` (a golden-ratio index order plus `drawRange`, no re-bake).
- **Deep links** (`share.js`): the Copy link button builds `?ship&mode&t&focus|cam=director` plus `#path=<base64url JSON>` for a custom path; `?t=` opens paused, `?focus=` focuses. `scenario.js` reads `#path=` before localStorage and never writes it (`scenario.sharedPath`). The URL is never touched while playing, and "Change ship" strips t/focus/cam/hash.

- `src/main.js` holds `applyTime(t)`, which poses everything for a given `t`, plus focus targets, picking and the render loop. `scenario.tEnd` is set here from the debris fall time. There is deliberately **no bloom pass**: the `Sky` shader outputs HDR values far above any usable threshold, so bloom turned the whole frame milky. Glow comes from additive sprites (flash, exhaust) instead.
- `src/labels.js` holds the floating tags (a `CSS2DRenderer` layer over the canvas, click-through) for the drone, missile and ship. `main.js` feeds it per-frame data from `applyTime`. The Labels button and the **L** key turn it off, and the choice is kept in `localStorage`. The ships carry no pennant number anywhere (tags, cards, hull paint): they are told apart by their launcher.
- `src/minimap.js` is the mini map: a 124 px translucent round radar (`#minimap`). On a normal screen it sits beside the timeline panel on the bottom row (`body.has-map` moves the panel right by the map's width, so nothing floats over the scene); on a phone it floats just above the bottom sheet (`--tl-h` is set from the timeline's height by a `ResizeObserver`), centred on the ship with the bow up (screen up = +X, screen right = +Z, so the ship's frame is shown unrotated). It draws range rings, each drone (arrow along its world velocity, a cross once down), each missile (arrow, then an expanding ring at the burst) and their paths in the ship frame (faint for the whole path, bright for the part flown). Auto zoom picks the smallest of `SCALES` that holds everything with a 15 % margin; clicking cycles auto / 500 m / 1 km / 2 km. It redraws only when `t` or the zoom changed. The **M** key or the menu hides it (`localStorage['intercept.map']`); the editor and the folded interface hide it too.
- `src/trails.js` draws the trajectories as thick `Line2` lines in their own colours: ship track (green), drone (orange like the airframe, drone 2 violet), missile (cyan, missile 2 pink). Each is a faint dashed preview (30 % opacity) of the whole planned path with a solid overlay, in a muted slate-tinted version of its colour, on the part the object has already consumed (its `instanceCount` is a pure function of `t`, so scrubbing works both ways). The missile line shows from 1 s before launch. The Trails button, the **T** key and the legend (`#trail-legend`) belong to it, the choice is kept in `localStorage['intercept.trails']`, and the path editor hides the trails while it is open. `LineMaterial` needs `resize(w, h)` from `main.js`.
- `src/pathEditor.js` is the path editor (⋯ menu, **E** key). It pauses at t = 0 and shows the path as a cyan spline with draggable handles, altitude stems and a sea shadow, all in a group that follows the ship. Tools:
  - **Move**: drag a dot, double-click the line to add a point, Delete removes one, ↑/↓ change altitude.
  - **Draw**: freehand strokes on the sea at a chosen altitude, right-drag to orbit.
  - Copy and Paste as JSON, Default, Clear.
  - Also: numbered handles; the path coloured by altitude with direction chevrons; range rings (150, 400, 650 m = `LAUNCH_RANGE`) on the sea; stat tiles (length, flight time from `flightTimeForLength`, altitude range, closest approach); exact Ahead / Stbd / Alt fields for the selected point; snap to 10/25/50 m; **Shift-drag** a dot to change its altitude; `[` / `]` step through points; undo/redo (Ctrl+Z, Ctrl+Y, 100 steps; one step per drag, stroke or field gesture); whole-path tools (Smooth, Simplify = Douglas-Peucker at 12 m, Flip L/R, Wider, Tighter, Raise/Lower all).

  Edits are only a preview until "Apply & play", which stores them and reloads. Pointer handlers are registered on `window` in the capture phase so a handle drag never reaches OrbitControls. The editor's logic can be driven in Node with a stand-in DOM. `timeline.js` ignores shortcuts typed into number/text inputs and passes Ctrl/Cmd chords to `onKey` (and `main.js` drops them unless the editor is open), so typing a value or pressing Ctrl+R never triggers playback.
- **Interface** (`index.html`, `style.css`, `hud.js`): a top-left bar holds the brand, view toggles (Director, Labels, Readouts, Sound) and a ⋯ menu (Edit path, Record, Copy link, Keyboard shortcuts, Change ship, `#dl-offline`). The camera picker (`[data-focus]`) and transport live in the bottom timeline. `#hud` (top right) is the only readout panel (the old `.telemetry` box is gone): drone and missile sections with status chips, all from `t`, replaced by the debrief at the end. Speeds are km/h, descent m/s. **C** (or Hide) hides the whole interface (`body.ui-hidden`, key `intercept.uiHidden`), **?** opens the shortcuts sheet, and Esc closes an open menu or sheet before freeing the camera. Layouts: desktop; ≤900 px (camera picker on its own row, no toolbar captions); phone portrait `(max-width: 640px) and (min-height: 501px)` (readouts become a one-line strip, the timeline is a bottom sheet, timeline labels become ticks only); phone landscape `(max-height: 500px)` (a single-row sheet). The timeline is hidden while the path editor is open. Panels sit at z 10–12, above the tag layer (z 5) and below the toast and error boxes. Timeline labels are placed in pixels in two rows by `layoutMarkers` in `timeline.js`, and a label that doesn't fit is hidden (its tick stays). Check pair mode after changing them: it has nine markers.
- `src/timeline.js` holds the master clock (`t`, play direction, speed) and the playback bar, markers and keys. The clock is the only source of time.

### Director camera and sound

- **`src/director.js`** is the cinematic camera. The UI calls it **Cinematic** (button, **D** key, `?cam=director` or `?cam=cinematic`); the code still says Director. **It is the default view**: `main.js` turns it on at start unless a shared link names its own camera (`?focus=`, or `?cam=free`, which "Copy link" writes for a free camera). Each shot is a pure function of `t` that places the camera and its look-at point, so cuts land on the same frames when scrubbing or playing backwards. The shot list is derived from `scenario` times (catapult, chase, low close pass found by the "Close pass" event, launcher, missile ride, wide impact, splash; recovery swaps the last three for a parachute orbit and splash). A shot shorter than `MIN_SHOT` is dropped, so custom paths still get sensible cuts. It needs `dronePos(t, out)` to resolve to the wreck after impact (`dronePosAt` in `main.js`) and `tWater`.
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
- **`parachute.js`** (recovery only): a red square ram-air-style canopy (an arched 5.4 m sheet, `archY`; its +Z follows the drone's heading) with 16 suspension lines along its edge and a pilot chute. Everything is a function of `t` and the drone's pose: lines pay out, the canopy streams then inflates, and after splashdown it collapses flat on the water downwind. The lines and pilot chute live in world space, and only the canopy has its own transform.
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
