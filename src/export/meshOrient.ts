// Wicklung von Dreiecks-Netzen nach aussen ausrichten — gemeinsam für Mesh-Export (OBJ/STL/glTF) und
// IFC-Export. Die 3D-Ableitungen (`plan/toWalls3d/*`) liefern keine verlässliche Wicklung, weil render3d
// doppelseitig zeichnet; Dateiformate verlangen sie.

/**
 * Richtet ein Dreiecks-Netz (Weltkoordinaten) so aus, dass die Flächennormalen nach AUSSEN zeigen:
 * Dreiecke werden über gemeinsame Kanten (Eckpunkte auf 0,01 mm verschweisst) zu Zusammenhangs-
 * Komponenten verbunden, jede Komponente zuerst in sich widerspruchsfrei gewickelt (Nachbarn
 * durchlaufen eine gemeinsame Kante gegenläufig) und dann nach dem Vorzeichen ihres Volumens
 * gedreht. Kanten mit mehr als zwei Dreiecken (Verschneidungen) verbinden nicht. Offene
 * Komponenten haben kein sinnvolles Volumen und bleiben, wie sie sind (nach dem Konsistenz-Schritt).
 */
export function orientOutward(pos: readonly number[], idx: readonly number[]): number[] {
  const nTri = Math.floor(idx.length / 3);
  const nVert = pos.length / 3;
  const weld = new Map<string, number>();
  const canon = new Array<number>(nVert);
  const q = (v: number) => Math.round(v * 1e5);
  for (let i = 0; i < nVert; i++) {
    const key = `${q(pos[3 * i])},${q(pos[3 * i + 1])},${q(pos[3 * i + 2])}`;
    let c = weld.get(key);
    if (c === undefined) {
      c = weld.size;
      weld.set(key, c);
    }
    canon[i] = c;
  }
  const N = weld.size + 1;
  // Kante (min,max) → [(Dreieck, vorwärts?)…]
  const edges = new Map<number, number[]>();
  const corner = (t: number, k: number) => canon[idx[3 * t + k]];
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const a = corner(t, k);
      const b = corner(t, (k + 1) % 3);
      if (a === b) continue;
      const key = Math.min(a, b) * N + Math.max(a, b);
      const list = edges.get(key);
      const entry = t * 2 + (a < b ? 1 : 0);
      if (list) list.push(entry);
      else edges.set(key, [entry]);
    }
  }
  // Nachbarschaft über Kanten mit genau zwei Dreiecken: Wicklungs-Paritaet (0 = gleich, 1 = gegenläufig noetig).
  const adj: number[][] = Array.from({ length: nTri }, () => []);
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const [e1, e2] = list;
    const t1 = e1 >> 1;
    const t2 = e2 >> 1;
    if (t1 === t2) continue;
    // Gleiche Durchlaufrichtung = Widerspruch ⇒ eines muss gedreht werden.
    const parity = (e1 & 1) === (e2 & 1) ? 1 : 0;
    adj[t1].push(t2 * 2 + parity);
    adj[t2].push(t1 * 2 + parity);
  }
  const flip = new Array<number>(nTri).fill(-1);
  const out = idx.slice();
  for (let s = 0; s < nTri; s++) {
    if (flip[s] >= 0) continue;
    const comp: number[] = [s];
    flip[s] = 0;
    for (let h = 0; h < comp.length; h++) {
      const t = comp[h];
      for (const e of adj[t]) {
        const u = e >> 1;
        if (flip[u] < 0) {
          flip[u] = flip[t] ^ (e & 1);
          comp.push(u);
        }
      }
    }
    // Volumen der Komponente mit den bisherigen Drehungen; Offenheit: Kante mit nur einem Dreieck.
    let vol = 0;
    for (const t of comp) {
      const [a, b, c] = flip[t] ? [idx[3 * t], idx[3 * t + 2], idx[3 * t + 1]] : [idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]];
      const A = a * 3;
      const B = b * 3;
      const C = c * 3;
      vol +=
        pos[A] * (pos[B + 1] * pos[C + 2] - pos[B + 2] * pos[C + 1]) -
        pos[A + 1] * (pos[B] * pos[C + 2] - pos[B + 2] * pos[C]) +
        pos[A + 2] * (pos[B] * pos[C + 1] - pos[B + 1] * pos[C]);
    }
    const turn = vol < 0 ? 1 : 0;
    for (const t of comp) {
      if (flip[t] ^ turn) {
        out[3 * t + 1] = idx[3 * t + 2];
        out[3 * t + 2] = idx[3 * t + 1];
      }
    }
  }
  return out;
}
