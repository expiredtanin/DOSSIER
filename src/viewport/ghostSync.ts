// [180] Geisterschicht (graue Klassen/Geschosse) im 3D: Abgleich der Antwort des Kerns mit dem, was render3d schon hat.
//
// Der Kern liefert die Schicht bei jeder Modelländerung neu (Cache rechnet nichts neu), render3d vernetzt sie dann
// vollständig. Ändert sich das Graue nicht (Wand im aktiven Geschoss bewegt), ist die Antwort Bit für Bit gleich:
// eine Prüfsumme aus Modell-Text und Linien-Puffern erkennt das, und die Schicht wird nicht neu gesetzt.

/** Zwei 32-Bit-Mischer (cyrb53-Art) über Wörter; 53 Bit Prüfsumme, Kollision praktisch ausgeschlossen. */
function mix(words: ArrayLike<number>, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    h1 = Math.imul(h1 ^ w, 2654435761);
    h2 = Math.imul(h2 ^ w, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function codes(s: string): Uint16Array {
  const a = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

/** Prüfsumme der Geisterschicht: Modell-JSON (`""` = keine), 2D-Spuren und Flächenmuster. Leere Schicht ⇒ `""`. */
export function ghostSignature(modelJson: string, drawing: Float32Array, pattern: Float32Array): string {
  if (!modelJson && !drawing.length && !pattern.length) return "";
  const bits = (f: Float32Array) => new Uint32Array(f.buffer, f.byteOffset, f.length);
  return [modelJson.length, mix(codes(modelJson), 1), drawing.length, mix(bits(drawing), 2), pattern.length, mix(bits(pattern), 3)].join(":");
}
