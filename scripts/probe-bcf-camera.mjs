// Browser-Prüfung der BCF-Kamera ([BCF]): Panel öffnen, .bcfzip laden, Themen anklicken und den
// Kamerazustand über das Debug-Handle `window.__dossierCamera` (s. `viewport/cameraBridge.ts`)
// lesen. WebGPU-Frames sind im Container oft leer — deshalb zählt der Kamerazustand, nicht das Bild.
//
// Aufruf: PROBE_URL=http://localhost:5191/ BCF_FILE=pfad/test.bcfzip [PROJECT_FILE=pfad/demo.obp] node scripts/probe-bcf-camera.mjs
// Die Datei hat zwei Themen: "Perspektive" (Position 12/10/8, Blick -12/-10/-7, Z oben, Schnittebene
// y=2) und "Ortho Grundriss" (Position 2.5/2/30, Blick -Z, ViewToWorldScale 16).
import { chromium } from "playwright";

const URL = process.env.PROBE_URL || "http://localhost:5191/";
const FILE = process.env.BCF_FILE;
if (!FILE) throw new Error("BCF_FILE fehlt");
const OUT = process.env.PROBE_OUT || ".";

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_BIN || undefined,
  args: ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(URL, { waitUntil: "load" });
// Startbildschirm: neues Projekt, danach (falls angegeben) das Demo-Projekt über das versteckte
// .obp-Input der App laden (der Dateidialog des Startbildschirms ist nur in der Tauri-App aktiv).
await page.getByText("Neues Projekt", { exact: true }).first().click();
if (process.env.PROJECT_FILE) {
  await page.setInputFiles('input[accept="application/json,.json,.obp"]', process.env.PROJECT_FILE);
  await page.waitForTimeout(800);
}
await page.waitForSelector("canvas", { timeout: 30000 });
await page.waitForTimeout(2500);

// 3D-Ansicht (Isometrie-Preset) einschalten; der Viewport meldet sich erst bei bereitem Renderer an.
await page.locator('button[title^="Isometrie —"]').first().click().catch(() => {});
await page.waitForFunction(() => window.__dossierCamera?.viewportAvailable() === true, null, { timeout: 15000 }).catch(() => {});
console.log("INFO WebGPU im Browser:", await page.evaluate(async () => (navigator.gpu ? !!(await navigator.gpu.requestAdapter()) : false)));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const cam = () => page.evaluate(() => window.__dossierCamera?.getCamera() ?? null);
const near = (a, b, tol = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};

check("Viewport meldet sich an", await page.evaluate(() => window.__dossierCamera?.viewportAvailable() === true));

// Panel öffnen: Menü Fenster > BCF-Themen
await page.getByText("Fenster", { exact: true }).first().click();
await page.getByText("BCF-Themen", { exact: true }).first().click();
await page.waitForSelector(".bcf-panel", { timeout: 5000 });
await page.setInputFiles(".bcf-panel input[type=file]", FILE);
await page.waitForSelector(".bcf-topic", { timeout: 10000 });
check("Datei geladen, 3 Themen", (await page.locator(".bcf-topic").count()) === 3);

// Perspektivisches Thema
await page.locator(".bcf-topic", { hasText: "Perspektive" }).click();
await page.waitForTimeout(900); // Kamerafahrt 350 ms
let c = await cam();
check("Perspektive: Kamera gesetzt", !!c && c.kind === "perspective", JSON.stringify(c && { p: c.position, d: c.direction, fov: c.fovDeg }));
if (c) {
  check("Perspektive: Position 12/10/8", near(c.position, [12, 10, 8], 0.01), c.position.map((x) => x.toFixed(3)).join("/"));
  check("Perspektive: Blickrichtung", near(c.direction, norm([-12, -10, -7]), 1e-4));
  check("Perspektive: Sichtfeld 60°", Math.abs(c.fovDeg - 60) < 1e-6);
  check("Perspektive: Up zeigt nach oben (z)", c.up[2] > 0.5);
}
check("Schnittebene aus dem Viewpoint: Schnitt-Knopf sichtbar", (await page.locator('button[aria-label][title*="BCF"]').count()) >= 1);
await page.screenshot({ path: `${OUT}/bcf-camera-perspective.png` });

// Orthogonales Thema
await page.locator(".bcf-topic", { hasText: "Ortho" }).click();
await page.waitForTimeout(900);
c = await cam();
check("Ortho: Kamera gesetzt", !!c && c.kind === "orthogonal", JSON.stringify(c && { p: c.position, d: c.direction, h: c.orthoHeight, a: c.aspect }));
if (c) {
  check("Ortho: Position 2.5/2/30", near(c.position, [2.5, 2, 30], 0.01), c.position.map((x) => x.toFixed(4)).join("/"));
  check("Ortho: Blick nach unten", near(c.direction, [0, 0, -1], 1e-3));
  check("Ortho: Breite 16 m", Math.abs(c.orthoHeight * c.aspect - 16) < 0.01, `Höhe ${c.orthoHeight.toFixed(3)} · Aspekt ${c.aspect.toFixed(3)}`);
}
check("Ortho: Schnitt wieder aufgehoben", (await page.locator('button[aria-label][title*="BCF"]').count()) === 0);

// Rundreise: Kamera lesen → setzen → lesen
const before = await cam();
await page.evaluate((v) => window.__dossierCamera.setCamera(v, { animate: false }), before);
await page.waitForTimeout(200);
const after = await cam();
check("getCamera → setCamera → getCamera unverändert", !!before && !!after && near(before.position, after.position, 1e-4) && near(before.direction, after.direction, 1e-4) && Math.abs(before.orthoHeight - after.orthoHeight) < 1e-4);

// Ansicht aufnehmen: aktuelle Kamera (+ Schnappschuss) als weiterer Viewpoint des Themas. (Die Auswahl
// "Thema aus Auswahl" nutzt denselben Aufnahmeweg; hier ohne Auswahl, weil das Demo-Projekt im
// Browser-Lauf keine passenden GlobalIds liefert.)
await page.locator(".bcf-topic", { hasText: "Perspektive" }).click();
await page.waitForTimeout(900);
await page.locator('button[title^="Axonometrie"]').first().click().catch(() => {});
await page.waitForTimeout(600);
const atCapture = await cam();
await page.getByRole("button", { name: "Ansicht aufnehmen" }).click();
await page.waitForTimeout(1200);
check("Ansicht aufnehmen: zweiter Viewpoint", (await page.locator(".bcf-vp").count()) === 2);
const snaps = await page.locator(".bcf-vp img.bcf-snapshot").count();
console.log(`INFO Schnappschuss im Viewpoint: ${snaps > 0 ? "ja" : "nein (Container: WebGPU-Frame leer, Kamera trotzdem gespeichert)"}`);
// Zurück auf den ersten Viewpoint, dann auf den neuen: die aufgenommene Kamera kommt wieder.
await page.locator(".bcf-vp").nth(0).click();
await page.waitForTimeout(900);
const first = await cam();
check("Viewpoint 1 stellt die Perspektive wieder her", !!first && near(first.position, [12, 10, 8], 0.01));
await page.locator(".bcf-vp").nth(1).click();
await page.waitForTimeout(900);
const restored = await cam();
check("Viewpoint 2 stellt die aufgenommene Kamera wieder her", !!atCapture && !!restored && near(atCapture.position, restored.position, 0.01) && near(atCapture.direction, restored.direction, 1e-3) && atCapture.kind === restored.kind, restored ? restored.position.map((x) => x.toFixed(2)).join("/") : "");
// Kommentar mit angehängter Ansicht (Häkchen ist voreingestellt)
await page.locator(".bcf-input").fill("Prüfen bitte");
await page.getByRole("button", { name: "Kommentieren" }).click();
await page.waitForTimeout(1200);
check("Kommentar mit Ansicht: dritter Viewpoint", (await page.locator(".bcf-vp").count()) === 3);
await page.screenshot({ path: `${OUT}/bcf-camera-topic.png` });

console.log("Konsolenfehler:", errors.length ? errors.slice(0, 5) : "keine");
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
