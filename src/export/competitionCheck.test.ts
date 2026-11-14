// [208] Anonymitäts-Prüfung des Freitexts: Treffer je Textort, keine Treffer ohne Anonymität, Kopfdaten leer.
// Die Logik liegt im Kern (`competition.rs`, dort die ausführlichen Fälle); hier die TS-Fassade und die Kopfdaten.

import "../engine/fileioWasm.setup";
import { describe, expect, it } from "vitest";
import { sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import { anonymityFindings } from "./competitionCheck";
import { competitionIdentity } from "./competitionIdentity";
import { pdfInfoFields } from "./pdfInfo";
import { exportIfcSpf } from "./exportIfc";

function project(anonymous: boolean): Project {
  const p = structuredClone(sampleProject) as Project;
  return {
    ...p,
    name: "Seeblick Meierhofer",
    projectNumber: "2026-017",
    competition: { anonymous, keyword: "FALKE 7", identifiers: "Atelier Brunner AG, info@brunner-arch.ch" },
    rooms: [{ ...(p.rooms?.[0] ?? { id: "r1", levelId: p.drawingLevels[0].id, polygon: [] }), id: "r1", name: "Büro Brunner" }] as Project["rooms"],
    layouts: [{ id: "l1", name: "Plan 2026/017", paper: "a1", orientation: "landscape", viewports: [] }],
  } as Project;
}

describe("anonymityFindings", () => {
  it("findet Treffer in Räumen und Blattnamen, mit Ort und Begriff", () => {
    const f = anonymityFindings(project(true), { texts: [{ area: "export", place: "fileName", text: "Seeblick Meierhofer.pdf" }] });
    expect(f.some((x) => x.area === "rooms" && x.kind === "identifier" && x.text === "Büro Brunner")).toBe(true);
    expect(f.some((x) => x.area === "layouts" && x.kind === "number")).toBe(true);
    expect(f.some((x) => x.area === "export" && x.kind === "name")).toBe(true);
  });

  it("meldet nichts, wenn die Abgabe nicht anonym ist", () => {
    expect(anonymityFindings(project(false))).toEqual([]);
  });

  it("Kopfdaten anonym leer: PDF-Info nur Kennwort, Bearbeiter leer, IFC ohne Projektname", () => {
    const p = project(true);
    expect(pdfInfoFields(p, "Anna Brunner")).toEqual({ title: "FALKE 7", author: "", subject: "", keywords: "", creator: "" });
    expect(competitionIdentity(p).author("Anna Brunner")).toBe("");
    expect(competitionIdentity(p).creator()).toBe("");
    const ifc = exportIfcSpf(p);
    expect(ifc.toLowerCase()).not.toContain("meierhofer"); // Stammdaten: neutralisiert
    // Der Raumname „Büro Brunner" (Freitext) steht dagegen im IFC — genau das meldet die Prüfung vorher.
    expect(ifc.toLowerCase()).toContain("brunner");
  });
});
