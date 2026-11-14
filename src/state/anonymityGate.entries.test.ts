// [208] Abgleich: Jede Stelle der Oberfläche, die eine Datei ausgibt (Berichte, Bilder, Pakete, Pläne …), ruft das
// Anonymitäts-Tor (`anonymityGate.ts`) auf. Neue Export-Einstiege fallen hier auf, bevor sie ohne Prüfung ausgeliefert werden.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

/** Aufrufe, die eine Datei an die Nutzerin ausgeben. */
const SINKS = /\b(saveBinaryFile|saveTextFile|saveTextWithCompanion|downloadCsv|downloadFile|savePlanPdf|savePlanSvg|savePlanDxf)\(|buildAreaReportPdf\(.*\)\.save\(/;
const GATE = /confirmAnonymousExport|runWithAnonymityGate/;

/** Bewusst ohne Tor: Schreiber selbst, Zusammenarbeit (BCF, keine Abgabe), CLI/MCP (eigene Prüfung). */
const EXEMPT = [
  /^native\//,
  /^export\//,
  /^cli\//,
  /^core\//,
  /^panels\/downloadFile\.ts$/,
  /^panels\/BcfPanel\.tsx$/,
  /^state\/anonymityGate\.ts$/,
];

describe("Anonymitäts-Tor", () => {
  it("jede Datei mit Export-Aufruf in der Oberfläche ruft das Tor auf", () => {
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      if (EXEMPT.some((r) => r.test(rel))) continue;
      const text = readFileSync(file, "utf8");
      if (SINKS.test(text) && !GATE.test(text)) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });

  it("das Tor ist in den bekannten Einstiegen angeschlossen", () => {
    const expected = [
      "state/useExportHandlers.ts", // Plan-PDF/SVG/DXF
      "state/useProjectFileActions.ts", // CSV/IFC/OBJ/STL/GLB/STEP
      "state/publishActions.ts", // Publikation
      "state/panelHost/layoutsHost.ts", // Layout-Ordner als PDF
      "state/aiAccess.ts", // KI-Werkzeuge (Speichern)
      "ui/ImageExportDialog.tsx", // 3D-Bild PNG
      "ui/RenderDialog.tsx", // Rendering PNG, .blend, Blender-Paket
      "ui/CameraTourDialog.tsx", // Kamerafahrt (Video)
      "panels/AreaTableSection.tsx",
      "panels/RoomBookSection.tsx",
      "panels/CostEstimateSection.tsx",
      "panels/OpeningScheduleSection.tsx",
      "panels/ElementScheduleSection.tsx",
      "panels/ProgramCompareSection.tsx",
      "panels/RoomBalancePanel.tsx",
    ];
    for (const rel of expected) expect(GATE.test(readFileSync(join(SRC, rel), "utf8")), rel).toBe(true);
  });
});
