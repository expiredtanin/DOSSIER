// [180] Geisterschicht (graue Klassen/Geschosse) im 3D: Abgleich der Antwort des Kerns mit dem, was render3d schon hat.
//
// Die Schicht reist wie das Hauptmodell als Teile ([214], {@link GhostLayerSync}): nur geänderte Teile gehen an
// render3d (`set_ghost_parts`), das nur sie neu vernetzt. Für den Ganz-Weg (Explosion) und die 2D-Spuren/Flächenmuster
// erkennt eine Prüfsumme eine Bit für Bit gleiche Antwort, dann wird nichts neu gesetzt.

import type { Model3dPart } from "../core";
import { Model3dPartsSync } from "./model3dPartsSync";

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

/** Teil-Update, das die Geisterschicht in render3d leert. */
export const GHOST_CLEAR = '{"reset":true,"remove":[],"upsert":[]}';

const EMPTY = new Float32Array(0);

/**
 * [180]/[214] Abgleich der Geisterschicht mit render3d. Normalweg: die grauen Elemente als Teile wie das Hauptmodell
 * (`projectToModel3dParts` mit dem Geister-Filter, `set_ghost_parts`): nur Geändertes reist und wird neu vernetzt;
 * unveränderte Wand-/Öffnungs-Einträge vergleicht {@link Model3dPartsSync} ohne JSON. Ganz-Weg (Explosion, ältere
 * WASM-Builds): das ganze Modell als JSON (`set_ghost_model`), nur bei geänderter Prüfsumme. Die 2D-Spuren und
 * Flächenmuster der Schicht werden nur bei geänderter Prüfsumme neu gesetzt.
 */
export class GhostLayerSync {
  private readonly parts = new Model3dPartsSync();
  /** Prüfsumme des zuletzt über den Ganz-Weg gesetzten Modells (`null` = Teile-Weg bzw. unbekannt). */
  private modelSig: string | null = null;
  private linesSig: string | null = null;
  /** render3d hält eine nicht leere Schicht (aus einem der beiden Wege). */
  private filled = false;

  /** Neuer Renderer: alles neu schicken. */
  reset(): void {
    this.parts.reset();
    this.modelSig = null;
    this.linesSig = null;
    this.filled = false;
  }

  /** Teile der grauen Elemente (`null` = keine graue Klasse): JSON für `set_ghost_parts`, `null` = nichts zu tun. */
  partsUpdate(parts: Model3dPart[] | null): string | null {
    this.modelSig = null;
    if (!parts) {
      if (!this.filled) return null;
      this.filled = false;
      this.parts.reset();
      return GHOST_CLEAR;
    }
    const d = this.parts.diff(parts);
    this.filled = parts.length > 0;
    return d ? d.json : null;
  }

  /** Ganz-Weg: `true`, wenn `set_ghost_model(json)` nötig ist (`""` = keine Schicht). */
  modelChanged(json: string): boolean {
    this.parts.reset();
    const sig = ghostSignature(json, EMPTY, EMPTY);
    const changed = sig !== this.modelSig && (json !== "" || this.filled);
    this.modelSig = sig;
    this.filled = json !== "";
    return changed;
  }

  /** `true`, wenn die 2D-Spuren/Flächenmuster der Schicht neu zu setzen sind. */
  linesChanged(drawing: Float32Array, pattern: Float32Array): boolean {
    const sig = ghostSignature("", drawing, pattern);
    if (sig === this.linesSig) return false;
    this.linesSig = sig;
    return true;
  }
}
