// Probe: belegt den kontextabhängigen „Darstellung"-Dropdown.
//  1) Grundriss + „Schwarz-Weiss" (mono) → scripts/probe-plan-mono.png
//  2) Grundriss + „Farbig" (Referenz)    → scripts/probe-plan-color.png
//  3) Perspektive + „Weiss" (Clay)       → scripts/probe-3d-white.png
//  4) Perspektive + „Schattiert" (Ref.)  → scripts/probe-3d-shaded.png
import puppeteer from "puppeteer";

const URL = process.env.PROBE_URL || "http://localhost:5173/";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 });

// Den Ansichts-Umschalter-Button per sichtbarem Text klicken.
const clickByText = async (sel, text) => {
  const handle = await page.evaluateHandle(
    (sel, text) =>
      [...document.querySelectorAll(sel)].find(
        (el) => el.textContent.trim() === text,
      ),
    sel,
    text,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`Button "${text}" (${sel}) nicht gefunden`);
  await el.click();
};

// Den „Darstellung"-Dropdown (per title) auf einen Wert setzen.
const setStyle = async (value) => {
  const sel = await page.$('select.layout-menu[title*="Darstellungsart der"]');
  if (!sel) throw new Error("Darstellung-Dropdown nicht gefunden");
  await sel.select(value);
  await new Promise((r) => setTimeout(r, 600));
};

const shot = (name) => page.screenshot({ path: `scripts/${name}` });

// 1) Grundriss aktiv (Default), Schwarz-Weiss.
await clickByText("button.view-btn", "Grundriss");
await new Promise((r) => setTimeout(r, 400));
await setStyle("color");
await shot("probe-plan-color.png");
await setStyle("mono");
await shot("probe-plan-mono.png");

// 2) Perspektive, Weiss vs. Schattiert.
await clickByText("button.view-btn", "Perspektive");
await new Promise((r) => setTimeout(r, 800));
await setStyle("shaded");
await shot("probe-3d-shaded.png");
await setStyle("white");
await new Promise((r) => setTimeout(r, 600));
await shot("probe-3d-white.png");

console.log("Screenshots geschrieben: probe-plan-color/mono, probe-3d-shaded/white");
console.log("\n=== Logs ===");
console.log(logs.length ? logs.join("\n") : "(keine)");
await browser.close();
