// Tests für `splitDxfForParallelParse`: die Aufteilung darf NIE mitten in
// einen POLYLINE/VERTEX/SEQEND- oder INSERT/ATTRIB/SEQEND-Verbund schneiden
// (s. Kopfkommentar `dxfEntityChunker.ts`) und muss bei kleinen/kaputten/
// exotischen Dateien sauber `null` liefern statt zu raten.

import { describe, expect, it } from "vitest";
import { parseDxf } from "./dxfParser";
import { DXF_CHUNK_CLOSER, splitDxfForParallelParse } from "./dxfEntityChunker";

/** Ein LINE-Entity (Top-Level, in sich geschlossen, kein Fortsetzungsrecord). */
function line(x1: number, y1: number, x2: number, y2: number): string[] {
  return [
    "0", "LINE", "8", "0",
    "10", `${x1}`, "20", `${y1}`, "30", "0",
    "11", `${x2}`, "21", `${y2}`, "31", "0",
  ];
}

/** Ein POLYLINE+VERTEX*+SEQEND-Verbund (muss immer als Ganzes erhalten bleiben). */
function polyline(...pts: Array<[number, number]>): string[] {
  const g = ["0", "POLYLINE", "8", "0", "70", "0"];
  for (const [x, y] of pts) {
    g.push("0", "VERTEX", "8", "0", "10", `${x}`, "20", `${y}`, "30", "0");
  }
  g.push("0", "SEQEND");
  return g;
}

/** Ein INSERT+ATTRIB*+SEQEND-Verbund. */
function insertWithAttrib(name: string, text: string): string[] {
  return [
    "0", "INSERT", "2", name, "10", "0", "20", "0", "30", "0",
    "0", "ATTRIB", "8", "0", "1", text,
    "0", "SEQEND",
  ];
}

/** Baut ein DXF nur aus einer ENTITIES-Sektion (kein HEADER/TABLES/BLOCKS). */
function dxfEntitiesOnly(...entities: string[][]): string {
  const lines = ["0", "SECTION", "2", "ENTITIES"];
  for (const e of entities) lines.push(...e);
  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\n");
}

/** Füllt `text` mit Padding (als Kommentargruppen 999, die dxf-parser & der
 *  Chunker gleichermassen als gewöhnliche Property-Paare behandeln) auf eine
 *  Mindestgrösse auf, ohne die Entity-Struktur zu verändern — damit die
 *  20-MB-Schwelle in Tests ohne eine wirklich riesige Datei erreicht wird. */
function padEntity(bigComment: string): string[] {
  return ["999", bigComment];
}

const PAD = "x".repeat(1024);
function manyLines(entityBuilder: () => string[], count: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < count; i++) out.push([...entityBuilder(), ...padEntity(PAD)]);
  return out;
}

describe("splitDxfForParallelParse", () => {
  it("liefert null für Text unter der Grössenschwelle", () => {
    const text = dxfEntitiesOnly(line(0, 0, 1, 1), line(1, 1, 2, 2));
    expect(splitDxfForParallelParse(text, 4)).toBeNull();
  });

  it("liefert null, wenn chunkCount <= 1", () => {
    const text = dxfEntitiesOnly(...manyLines(() => line(0, 0, 1, 1), 30000));
    expect(splitDxfForParallelParse(text, 1)).toBeNull();
  });

  it("liefert null ohne ENTITIES-Sektion", () => {
    const text = "0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n" + PAD.repeat(25000);
    expect(splitDxfForParallelParse(text, 4)).toBeNull();
  });

  it("teilt eine grosse, reine LINE-Datei in mehrere Chunks auf, die sich wieder zu denselben Entities zusammensetzen", () => {
    const entities = manyLines(() => line(0, 0, 1, 1), 30000);
    const text = dxfEntitiesOnly(...entities);
    const split = splitDxfForParallelParse(text, 4);
    expect(split).not.toBeNull();
    expect(split!.chunks.length).toBeGreaterThan(1);

    let totalContours = 0;
    for (const chunk of split!.chunks) {
      const res = parseDxf(split!.preamble + chunk + DXF_CHUNK_CLOSER);
      totalContours += res.contours[0]?.contours.length ?? 0;
    }
    expect(totalContours).toBe(30000);
  });

  it("schneidet NIE mitten in einen POLYLINE/VERTEX/SEQEND-Verbund", () => {
    // Viele kleine LINEs plus durchmischte POLYLINE-Verbünde, damit ein
    // naiver Split mitten in einer Polyline landen WÜRDE, wäre die Logik
    // falsch.
    const entities: string[][] = [];
    for (let i = 0; i < 20000; i++) {
      entities.push([...line(0, 0, 1, 1), ...padEntity(PAD)]);
      if (i % 50 === 0) {
        entities.push([
          ...polyline([0, 0], [1, 0], [1, 1], [0, 1], [0, 0]),
          ...padEntity(PAD),
        ]);
      }
    }
    const text = dxfEntitiesOnly(...entities);
    const split = splitDxfForParallelParse(text, 6);
    expect(split).not.toBeNull();

    let totalLineContours = 0;
    let totalPolylineContours = 0;
    for (const chunk of split!.chunks) {
      // Jeder Chunk muss für sich eine gültige DXF-Datei sein — wirft
      // `parseDxf`, ist das ein harter Testfehler (kaputt gesplittet).
      const res = parseDxf(split!.preamble + chunk + DXF_CHUNK_CLOSER);
      for (const set of res.contours) {
        for (const c of set.contours) {
          if (c.pts.length === 2) totalLineContours++;
          else totalPolylineContours++;
        }
      }
    }
    expect(totalLineContours).toBe(20000);
    expect(totalPolylineContours).toBe(400); // 20000 / 50
  });

  it("schneidet NIE mitten in einen INSERT/ATTRIB/SEQEND-Verbund", () => {
    const entities: string[][] = [];
    for (let i = 0; i < 20000; i++) {
      entities.push([...insertWithAttrib("blk", `Attribut ${i}`), ...padEntity(PAD)]);
    }
    const text = dxfEntitiesOnly(...entities);
    const split = splitDxfForParallelParse(text, 5);
    expect(split).not.toBeNull();

    for (const chunk of split!.chunks) {
      // Darf nicht werfen — ein kaputt getrennter INSERT/ATTRIB/SEQEND-
      // Verbund würde `dxf-parser` strukturell aus dem Takt bringen.
      expect(() => parseDxf(split!.preamble + chunk + DXF_CHUNK_CLOSER)).not.toThrow();
    }
  });
});
