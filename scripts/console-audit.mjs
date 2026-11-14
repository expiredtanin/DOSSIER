// [206] Konsolen-Audit: spielt den Referenz-Ablauf grob durch und sammelt ALLE Konsolen-Meldungen ab Stufe
// warning (+ pageerror, fehlgeschlagene Requests, HTTP >= 400, lange Tasks), gruppiert und zählt sie.
// Kein Test (kein Exit-Code != 0), sondern Messgerät.
//   npx vite build --outDir dist-test && npx vite preview --outDir dist-test --port 5198 --strictPort &
//   node scripts/console-audit.mjs [--gpu]   (ohne --gpu: ?dossierTest&gl=0; mit: ?dossierTest, WebGPU/SwiftShader)
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";

const PORT = process.env.E2E_PORT ?? 5198;
const gpu = process.argv.includes("--gpu");
const exe = process.env.DOSSIER_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch({ executablePath: exe, args: ["--enable-unsafe-webgpu"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "de-CH", acceptDownloads: true });
const page = await ctx.newPage();

const groups = new Map();
let phase = "start";
const norm = (s) => s.replace(/\d+(\.\d+)?/g, "N").replace(/\s+/g, " ").slice(0, 300);
const add = (kind, text) => {
  const key = `${kind} | ${norm(text)}`;
  const g = groups.get(key) ?? { kind, text: text.slice(0, 600), n: 0, phases: new Set() };
  g.n++;
  g.phases.add(phase);
  groups.set(key, g);
};
page.on("console", (m) => {
  if (!["warning", "error"].includes(m.type())) return;
  const loc = m.location();
  add(m.type(), m.text() + (loc.url ? `  @${loc.url.split("/").slice(-1)[0]}:${loc.lineNumber}` : ""));
});
page.on("pageerror", (e) => add("pageerror", e.message));
page.on("requestfailed", (r) => add("requestfailed", `${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => {
  if (r.status() >= 400) add("http" + r.status(), r.url());
});
await page.addInitScript(() => {
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.duration > 200) console.warn(`[longtask] ${Math.round(e.duration)} ms`);
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* ohne longtask-Unterstützung */
  }
});

const step = async (name, fn) => {
  phase = name;
  try {
    await fn();
  } catch (e) {
    add("script", `Schritt „${name}“: ${String(e.message).split("\n")[0]}`);
  }
  await page.waitForTimeout(500);
};
const fileMenu = async (item) => {
  await page.getByRole("button", { name: "Datei", exact: true }).click();
  await page.getByRole("option", { name: item }).click();
};
const discard = async () => {
  const b = page.getByRole("button", { name: "Nicht speichern" });
  if (await b.waitFor({ timeout: 1500 }).then(() => true, () => false)) await b.click();
};
const tab = (n) => page.getByRole("tab", { name: n, exact: true }).click({ timeout: 5000 });
const viewMenu = async (opt) => {
  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  await page.getByRole("option", { name: opt }).first().click();
};
const snapshot = async (n) => {
  await tab("Ausschnitte");
  await page.locator(".nav-row").filter({ has: page.getByText(n, { exact: true }) }).first().click();
  await page.waitForTimeout(1200);
};

await page.goto(`http://localhost:${PORT}/?dossierTest${gpu ? "" : "&gl=0"}`);
await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
await page.getByRole("group", { name: "Befehlszeile" }).waitFor();

await step("Musterhaus", async () => {
  await fileMenu(/^Neu aus Vorlage: Musterhaus$/);
  await discard();
  await page.locator(".project-name").filter({ hasText: "Demo-Haus" }).waitFor();
  await viewMenu("Perspektive");
  await page.waitForTimeout(1500);
  await viewMenu("Iso");
  await page.waitForTimeout(1000);
  await viewMenu("Grundriss");
});
await step("Panels", async () => {
  for (const n of ["Elemente", "Objekt-Info", "Flächenbilanz", "Gelände", "Zeichnungsebenen", "Ausschnitte", "Mappe"]) {
    await tab(n).catch(() => add("script", `Reiter ${n}: fehlt`));
  }
});
await step("Objekt setzen", async () => {
  await tab("Elemente");
  await page.getByRole("button", { name: "Wand", exact: true }).click();
  const inp = page.locator(".cmdline-input");
  await inp.focus();
  for (const p of ["20,0", "25,0", "25,4"]) {
    await inp.fill(p);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+z");
});
await step("Ressourcen-Manager", async () => {
  await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
  await page.getByRole("option", { name: /Ressourcen/ }).click();
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
});
await step("Komplex", async () => {
  await fileMenu(/Musterhaus \(komplex\)/);
  await discard();
  await page.locator(".project-name").filter({ hasText: "Musterhaus komplex" }).waitFor({ timeout: 30000 });
  for (const n of ["EG 1:100", "Schnitt A-A", "Ansicht Süd", "Axonometrie Südost", "EG 1:100"]) await snapshot(n);
  await tab("Mappe");
  await page.locator(".nav-row", { hasText: "Grundrisse UG / EG" }).first().dblclick();
  await page.locator(".layout-sheet-pane").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const pending = page.waitForEvent("download", { timeout: 120000 });
  await page.locator("[data-publish-set=pub-baueingabe] [data-publish-run]").click();
  await pending;
});
await step("Wettbewerb", async () => {
  await fileMenu(/Neu aus Vorlage: Wettbewerb/);
  await discard();
  await page.waitForTimeout(3000);
  await tab("Flächenbilanz");
  await tab("Gelände");
  await tab("Mappe");
  await page.locator(".nav-row", { hasText: "Layout" }).first().dblclick().catch(() => {});
  await page.waitForTimeout(2500);
});

await browser.close();
const rows = [...groups.values()].sort((a, b) => b.n - a.n);
const byKind = {};
for (const g of rows) byKind[g.kind] = (byKind[g.kind] ?? 0) + g.n;
console.log(`# Konsolen-Audit (${gpu ? "WebGPU/SwiftShader" : "gl=0"})  Summe je Art:`, JSON.stringify(byKind));
for (const g of rows) console.log(`\n[${g.n}x] ${g.kind}  (${[...g.phases].join(", ")})\n  ${g.text.replace(/\n/g, "\n  ")}`);
