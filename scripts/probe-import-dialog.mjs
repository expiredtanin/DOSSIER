// Probe: DXF-Import-Dialog. Erzeugt eine kleine Test-DXF (LWPOLYLINE auf 2
// Layern), füttert sie in das versteckte Datei-Input, screenshotet den offenen
// Dialog, wählt „Neue Zeichnung" + Importieren und screenshotet den Grundriss.
import puppeteer from "puppeteer";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL = process.env.PROBE_URL || "http://localhost:5174/";

// ── Minimale Test-DXF: 2 LWPOLYLINE auf Layern „Waende" und „Moeblierung". ──
const dxf = `0
SECTION
2
ENTITIES
0
LWPOLYLINE
8
Waende
90
5
70
1
10
0
20
0
10
8
20
0
10
8
20
5
10
0
20
5
10
0
20
0
0
LWPOLYLINE
8
Moeblierung
90
4
70
0
10
2
20
1
10
4
20
1
10
4
20
3
10
2
20
3
0
ENDSEC
0
EOF
`;
const dxfPath = join(tmpdir(), "probe-import.dxf");
writeFileSync(dxfPath, dxf);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 });

// Datei in das versteckte DXF-Input legen → onChange öffnet den Dialog.
const input = await page.$('input[type="file"][accept*=".dxf"]');
if (!input) throw new Error("DXF-Datei-Input nicht gefunden");
await input.uploadFile(dxfPath);

await page.waitForSelector(".imp-dialog", { timeout: 5000 });
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: "scripts/probe-import-dialog.png" });
console.log("Dialog-Screenshot: scripts/probe-import-dialog.png");

// Zusammenfassung auslesen (Konturen/Layer sichtbar?).
const summary = await page.$$eval(".imp-summary li", (lis) =>
  lis.map((l) => l.textContent),
);
console.log("Zusammenfassung:", JSON.stringify(summary));

// Sicherstellen, dass „Neue Zeichnung" gewählt ist (Default), dann Importieren.
const importBtn = await page.$(".imp-btn.primary");
const disabled = await page.evaluate((b) => b.disabled, importBtn);
console.log("Import-Button disabled?", disabled);
await importBtn.click();

await new Promise((r) => setTimeout(r, 600));

// Dialog sollte geschlossen sein; Grundriss/Drawing-Ansicht der neuen Ebene.
const dialogGone = (await page.$(".imp-dialog")) === null;
console.log("Dialog geschlossen?", dialogGone);

// Anzahl Zeichnungsebenen-Zeilen + neuer „Zeichnung"-Eintrag prüfen (best effort).
const drawingCount = await page.evaluate(() => {
  const project = window.__store?.getState?.()?.project;
  if (!project) return null;
  return {
    drawingLevels: project.drawingLevels.map((z) => `${z.name}/${z.kind}`),
    drawings2d: project.drawings2d.length,
  };
});
console.log("Projekt:", JSON.stringify(drawingCount));

await page.screenshot({ path: "scripts/probe-import-plan.png" });
console.log("Plan-Screenshot: scripts/probe-import-plan.png");

console.log("\n=== Logs ===");
console.log(logs.length ? logs.join("\n") : "(keine)");
await browser.close();
