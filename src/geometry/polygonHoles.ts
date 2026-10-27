// Brücken-Trick: Aussparungen (Löcher) werden über schmale Brücken in den
// Aussenring eingefügt, sodass EIN einfacher (nicht selbstüberschneidender)
// Polygonring entsteht — kein Loch-Support in den nachgelagerten Primitiven
// nötig. Ein solcher Ring ist paritätsbasiert korrekt für SVG-/Canvas-Fill,
// Scanline-Hatch, Ear-Clipping-Triangulierung UND Punkt-in-Polygon-Pick.
//
// Fassade über den Rust-Kern (`src-tauri/core/src/polygon_holes.rs`, Bindung `web/polygon_holes.rs`).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";
import { FlatReader, FlatWriter } from "./coreFlat";

/** Ergebnis von {@link mergeHoles}. */
export interface MergedRing {
  /** Einfacher (nicht selbstüberschneidender) Polygonring mit eingefügten Löchern. */
  ring: Vec2[];
  /**
   * Kanten-Indizes der eingefügten Brückenkanten im Ergebnis-Ring (Kante i =
   * ring[i]→ring[(i+1)%n]) — für `noStrokeEdges` im 2D (Brückenkanten sind
   * künstliche Verbindungen, kein realer Bauteilrand, daher nicht stricheln).
   * Je Loch genau 2 Einträge.
   */
  bridgeEdges: number[];
}

/**
 * Fügt Aussparungen (`holes`) über schmale Brücken in `outline` ein, sodass
 * EIN einfacher Polygonring entsteht. Löcher werden ITERATIV in den (wachsenden)
 * Ring eingefügt: je Loch das nächstgelegene SICHTBARE Ring-/Loch-Vertex-Paar
 * verbinden; der Loch-Ring läuft gegenläufig zum Aussenring (Shoelace-Fläche =
 * Aussenfläche − Lochfläche). Die Brücke besteht aus ZWEI knapp parallelen Kanten
 * (`gap`-Versatz quer zur Brückenrichtung), damit der Ring einfach bleibt.
 *
 * Degenerierte Löcher (< 3 Punkte oder ~Nullfläche) sowie Löcher, deren
 * Schwerpunkt ausserhalb des aktuellen Rings liegt, werden übersprungen. Ohne
 * Löcher liefert die Funktion `outline` unverändert (Kopie) mit leeren `bridgeEdges`.
 */
export function mergeHoles(outline: Vec2[], holes: Vec2[][], gap = 1e-4): MergedRing {
  // Häufiger Fall (Decke ohne Aussparung): kein WASM-Aufruf nötig.
  if (outline.length < 3 || holes.length === 0) return { ring: outline.slice(), bridgeEdges: [] };
  const hw = new FlatWriter().num(holes.length);
  for (const h of holes) hw.ring(h);
  const buf = core().polygon_merge_holes(new FlatWriter().pts(outline).done(), hw.done(), gap);
  if (!buf.length) return { ring: outline.slice(), bridgeEdges: [] };
  const r = new FlatReader(buf);
  const bridgeEdges: number[] = [];
  for (let n = r.count(); n > 0; n--) bridgeEdges.push(r.num());
  return { ring: r.ring(), bridgeEdges };
}
