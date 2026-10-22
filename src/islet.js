import * as THREE from 'three';

// An island for the ship duel: a lumpy cone standing in the sea, built from the sim's own circle (x, z, r, h) so what the eye sees is what stops
// the shells and the radar (duel.js: height h * (1 - (d / r)^2)^1.2 inside the circle). A sandy rim, green slopes, grey rock at the top; no
// textures, flat-shaded vertex colours. The base goes under the water, so the waves lap at it.
const RINGS = 18, SECTORS = 64;

export function createIslet({ x, z, r, h }) {
  let seed = (Math.floor(x) * 73856093) ^ (Math.floor(z) * 19349663);
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
  const pos = [], col = [], idx = [];
  const sand = new THREE.Color(0.74, 0.68, 0.5), green = new THREE.Color(0.2, 0.36, 0.17), deepGreen = new THREE.Color(0.14, 0.27, 0.13);
  const rock = new THREE.Color(0.44, 0.43, 0.41), c = new THREE.Color();
  const heightAt = (d, th) => {
    const wob = 1 + 0.07 * Math.sin(3 * th + ph[0]) + 0.05 * Math.sin(5 * th + ph[1]);
    const u = d / (r * wob);
    if (u >= 1) return -7 * Math.min(1, (u - 1) / 0.3); // under the sea beyond the shore
    const base = h * (1 - u * u) ** 1.2;
    return base * (0.9 + 0.1 * Math.sin(7 * th + ph[2] + u * 6));
  };
  pos.push(0, heightAt(0, 0), 0); col.push(rock.r * 0.5, rock.g * 0.5, rock.b * 0.5);
  for (let j = 1; j <= RINGS; j++) {
    const d = (r * 1.3 * j) / RINGS;
    for (let s = 0; s < SECTORS; s++) {
      const th = (2 * Math.PI * s) / SECTORS;
      const y = heightAt(d, th);
      pos.push(Math.cos(th) * d, y, Math.sin(th) * d);
      const f = y / h;
      if (y < 2) c.copy(sand);
      else if (f < 0.35) c.copy(sand).lerp(green, Math.min(1, (y - 2) / 8));
      else if (f < 0.65) c.copy(green).lerp(deepGreen, (f - 0.35) / 0.3);
      else c.copy(deepGreen).lerp(rock, Math.min(1, (f - 0.65) / 0.2));
      const shade = 0.9 + 0.2 * ((s * 7 + j * 3) % 5) / 5; // a little variation from face to face
      col.push(c.r * shade * 0.5, c.g * shade * 0.5, c.b * shade * 0.5); // the scene is lit hard: dark colours read as the real thing
    }
  }
  const at = (j, s) => 1 + (j - 1) * SECTORS + (s % SECTORS);
  for (let s = 0; s < SECTORS; s++) idx.push(0, at(1, s + 1), at(1, s));
  for (let j = 1; j < RINGS; j++) for (let s = 0; s < SECTORS; s++) idx.push(at(j, s), at(j, s + 1), at(j + 1, s), at(j, s + 1), at(j + 1, s + 1), at(j + 1, s));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
  mesh.position.set(x, 0, z);
  mesh.name = 'islet';
  return mesh;
}
