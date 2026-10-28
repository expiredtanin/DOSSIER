// Browser-Laufzeittest: echter DWG-Import über den App-Import-Pfad.
// Lädt eine echte DWG über das versteckte File-Input (uploadFile), wartet bis
// das Rust-Format-Modul (Web-Worker) gelesen hat, und screenshotet den Import-Dialog mit der ECHTEN
// Zusammenfassung (Konturen/Layer) statt des ODA-Hinweises.

import puppeteer from "puppeteer";

const URL = process.env.URL || "http://localhost:5173/";
const SAMPLE =
  "/tmp/claude-1000/-home-karim-cad/65983130-c639-428b-bd68-85eafeb48d98/scratchpad/sample.dwg";

const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const p = await b.newPage();
await p.setViewport({ width: 1300, height: 900, deviceScaleFactor: 2 });
const logs = [];
p.on("pageerror", (e) => logs.push("ERR:" + e.message));
p.on("console", (m) => {
  if (m.type() === "error") logs.push("CONSOLE:" + m.text());
});

await p.goto(URL, { waitUntil: "networkidle0", timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 700));

// File-Input mit accept=".dxf,.dwg" finden und die echte DWG hochladen.
const input = await p.$('input[type=file][accept*=".dwg"]');
if (!input) {
  console.log("FAIL: DWG-File-Input nicht gefunden.");
  await b.close();
  process.exit(1);
}
await input.uploadFile(SAMPLE);

// Auf Ladehinweis screenshoten (kann sehr kurz sein), dann auf Ergebnis warten.
await new Promise((r) => setTimeout(r, 150));
await p.screenshot({ path: "scripts/probe-dwg-loading.png" }).catch(() => {});

// Warten, bis der Dialog die echte Zusammenfassung zeigt (oder bis Timeout).
let summaryText = "";
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 250));
  summaryText = await p.evaluate(() => {
    const sum = document.querySelector(".imp-summary");
    const hint = document.querySelector(".imp-dwg-hint");
    return JSON.stringify({
      summary: sum ? sum.textContent : null,
      hint: hint ? hint.textContent : null,
    });
  });
  const parsed = JSON.parse(summaryText);
  if (parsed.summary) break; // echte Zusammenfassung erschienen
}

await p.screenshot({ path: "scripts/probe-dwg-import.png" });
const parsed = JSON.parse(summaryText);
console.log("Dialog-Zusammenfassung:", parsed.summary);
console.log("ODA-Hinweis (sollte null sein bei Erfolg):", parsed.hint);
console.log("Logs:", logs.length ? logs.join(" | ") : "(keine)");

if (!parsed.summary) {
  console.log("FAIL: keine echte Zusammenfassung — DWG nicht geparst.");
  await b.close();
  process.exit(1);
}
console.log("OK: DWG über den Import-Pfad geparst, echte Zusammenfassung sichtbar.");
await b.close();
