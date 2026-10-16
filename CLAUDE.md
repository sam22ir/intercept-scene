# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Interactive Three.js scene: an orange target drone is catapulted off a side launch rail on a steaming stealth frigate (C28A style, pennant 920). It flies a loop, comes back for a low close pass along the port side, and climbs away. A missile from the frigate's forward box launcher then shoots it down. The user can scrub time forwards and backwards and click the drone, missile or ship to focus the camera on it. Vanilla JS (ES modules), Vite, `three@0.186.1`. No tests, no linter.

The folder name ends with a **trailing space** (`/home/saadi/plane sceen `). Quote every path in shell commands.

## Commands

```bash
pnpm install      # one install at a time on this machine
pnpm dev          # http://localhost:5173 (also the "dev" entry in .claude/launch.json)
pnpm build        # production bundle in dist/ (the >500 kB chunk warning is three.js, expected)
```

`src/scenario.js` imports only `three`, so timings and clearances can be checked in Node without a browser. Import it and sample `planeRelPos`, `missilePos` and `shipPos`.

In the browser console, `window.__scene` exposes `{ scenario, clock, setFocus, camera, controls, rig, renderer, plane, missile, ship }`, for example `__scene.clock.seek(__scene.scenario.tHit)`.

## Architecture

**Core rule: every visual is a pure function of the sim time `t`.** Nothing accumulates per-frame state, which is what makes reverse playback and scrubbing work. Any new animation must be computable from `t` alone, including flicker, strobes and flag ripple. A stateful update breaks scrubbing (check by jumping to the end, then back to 0).

### `src/scenario.js`

Holds the story, all timing and every ship mount point. Units are metres. The bow points +X, +Y is up, starboard is +Z. Model noses point along local +Z.

- **Moving ship frame**: the ship moves at constant `SHIP_SPEED`, and `shipPos(t)` is a pure translation, with no roll or pitch. The catapult `RAIL`, `LAUNCHER_PIVOT`/`TUBE_MOUTH` and `deckHeight(x)` are defined in the ship frame. `ship.js` builds its geometry from these same constants, so move a mount here, not in the model.
- **Drone path**:
  - On the rail, the drone strokes in closed form.
  - After release it follows a Catmull-Rom curve in the **ship frame** (`planeRelPos`), driven by a relative-airspeed profile through a precomputed arc-length table. `planePos` adds `shipPos`.
  - The first waypoint and tangent are derived from the rail-end pose, so the release is continuous.
  - Attitude follows the *relative* path; bank comes from turn rate.
- **Derived event times**: `tTurn` and `tClose` are measured in the ship frame, so editing `WAYPOINTS` or `SPEED_KEYS` moves the events automatically.
- **Missile**:
  - Proportional navigation is **simulated once at module load** into a fixed-rate sample table, starting from the tube mouth at `tLaunch` along the tube direction.
  - The last sample is snapped onto the drone, so the hit is exact. `tHit` is an output of that sim.
  - The launcher's slew (`launcherAim(t)`: stowed → aimed → stowed) is a pure function of `t`.
  - The drone's climb-away is ahead of the bow, so the missile's first second clears the superstructure. Keep it that way if you change the path.

### Rendering and timeline

- `src/main.js` holds `applyTime(t)`, which poses everything for a given `t`, plus focus targets, picking and the render loop. `scenario.tEnd` is set here from the debris fall time. There is deliberately **no bloom pass**: the `Sky` shader outputs HDR values far above any usable threshold, so bloom turned the whole frame milky. Glow comes from additive sprites (flash, exhaust) instead.
- `src/timeline.js` holds the master clock (`t`, play direction, speed) and the playback bar, markers and keys. The clock is the only source of time.

### Models

`src/models/` contains procedural geometry only, with **no external textures or assets**. Canvas textures are generated at load.

- **`kit.js`**: `Kit` collects parts per material and merges them, which keeps the detailed ship at a few dozen draw calls. Add new detail through a Kit, not as loose meshes. `hexa` builds sloped stealth blocks and auto-orients face winding. `slab` and `facePanel` place windows, doors and panels on sloped faces.
- **`ship.js`**:
  - The hull is lofted from per-level lines (keel, bilge, waterline, knuckle, deck) with raked stems. Each level pair is a separate strip, so creases stay sharp.
  - Hull UVs flip *u* on the port side, and port and starboard use different halves of the texture, so the painted "920" reads correctly on both sides.
  - The animated parts are the radar, launcher yaw/pitch, tube cap, catapult cradle and flag.
  - Ship pick boxes live inside the ship group.
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
  - **Particle bake**: catapult puff, drone exhaust haze, launch backblast, missile trail, fireball, burning smoke and splashes. Anything emitted from the ship must add the ship's velocity.
- **`src/cameraRig.js`** eases to a target, then carries the camera by the target's per-frame delta. Focus targets always resolve to a position:
  - The missile sits at its tube before launch, and the blast point after.
  - The drone hands over to its falling fuselage after impact.
  - Focus switches from the missile to the wreck at `tHit`.
- **Picking**: drone and missile pick spheres grow with camera distance and win over the ship's boxes.
