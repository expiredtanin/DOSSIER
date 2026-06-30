import puppeteer from "puppeteer";

const URL = process.env.PROBE_URL || "http://localhost:5187/";
const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
p.on("console", (m) => { if (m.type() === "error") errs.push("[console] " + m.text()); });
await p.goto(URL, { waitUntil: "networkidle0", timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 800));

const clickTab = (label) =>
  p.evaluate((x) => {
    const el = [...document.querySelectorAll("button, .tab, [role=tab]")].find(
      (b) => b.textContent.trim() === x,
    );
    el?.click();
    return !!el;
  }, label);

// Object-Info-Tab aktivieren (falls vorhanden).
const tabOk = await clickTab("Objekt-Info");
await new Promise((r) => setTimeout(r, 200));

// Eine Wand im Grundriss anklicken (obere Bandkante eines Wandpolygons).
async function selectWall() {
  const bb = await p.evaluate(() => {
    const polys = [...document.querySelectorAll(".plan-svg polygon")];
    if (!polys.length) return null;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const pl of polys) {
      const r = pl.getBoundingClientRect();
      minX = Math.min(minX, r.left); minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom);
    }
    return { minX, minY, maxX, maxY };
  });
  if (!bb) return false;
  const cx = (bb.minX + bb.maxX) / 2;
  for (const dy of [4, 8, 12, 16, 20]) {
    await p.mouse.click(cx, bb.minY + dy);
    await new Promise((r) => setTimeout(r, 120));
    const k = await p.evaluate(
      () => document.querySelector(".objinfo-kind")?.textContent || "",
    );
    if (/Wand/.test(k)) return true;
  }
  return false;
}

const selected = await selectWall();

// (1) Wand-Abschnitt sichtbar?
const hasWallSection = await p.evaluate(() =>
  [...document.querySelectorAll(".objinfo-section-label")].some(
    (e) => e.textContent.trim() === "Wand",
  ),
);
const hasRefDropdown = await p.evaluate(
  () => !!document.querySelector(".objinfo-head-ref"),
);
await p.screenshot({ path: "scripts/probe-wallattr-1-panel.png" });

// Plan-Footprint VORHER (bbox aller Wandpolygone).
const planBBox = () =>
  p.evaluate(() => {
    const polys = [...document.querySelectorAll(".plan-svg polygon")];
    let minY = 1e9, maxY = -1e9;
    for (const pl of polys) {
      const r = pl.getBoundingClientRect();
      minY = Math.min(minY, r.top); maxY = Math.max(maxY, r.bottom);
    }
    return { minY: Math.round(minY), maxY: Math.round(maxY) };
  });
const beforeRef = await planBBox();

// (2) Referenzlinie auf „Außen (links)" stellen über das Kopf-Dropdown.
async function pickDropdown(triggerSel, optionText) {
  const ok = await p.evaluate((sel) => {
    const t = document.querySelector(sel);
    if (!t) return false;
    t.click();
    return true;
  }, triggerSel);
  if (!ok) return false;
  await new Promise((r) => setTimeout(r, 150));
  const picked = await p.evaluate((txt) => {
    const item = [...document.querySelectorAll(".tb-dd-menu .tb-dd-item")].find(
      (i) => i.textContent.trim().includes(txt),
    );
    item?.click();
    return !!item;
  }, optionText);
  await new Promise((r) => setTimeout(r, 200));
  return picked;
}

const refPicked = await pickDropdown(
  ".objinfo-head-ref .tb-dd-trigger",
  "Außen",
);
await new Promise((r) => setTimeout(r, 250));
const afterRef = await planBBox();
await p.screenshot({ path: "scripts/probe-wallattr-2-refline-aussen.png" });

// (3) OK auf „eigene Höhe" → Z-Wert ändern, dann 3D.
// Den OK-Block (zweite objinfo-wall-anchor) auf „Eigene Höhe" schalten.
const okCustom = await p.evaluate(() => {
  const blocks = [...document.querySelectorAll(".objinfo-wall-anchor")];
  const okBlock = blocks[1];
  if (!okBlock) return false;
  const btn = [...okBlock.querySelectorAll(".objinfo-seg-btn")].find(
    (b) => b.textContent.trim() === "Eigene Höhe",
  );
  btn?.click();
  return !!btn;
});
await new Promise((r) => setTimeout(r, 200));
// Z-Feld setzen (5.0 m) im OK-Block.
const heightBefore = await p.evaluate(
  () =>
    [...document.querySelectorAll(".objinfo-field")]
      .find((f) => f.querySelector(".objinfo-flabel")?.textContent === "Höhe")
      ?.querySelector(".objinfo-fval")?.textContent || "",
);
const setZ = await p.evaluate(() => {
  const blocks = [...document.querySelectorAll(".objinfo-wall-anchor")];
  const okBlock = blocks[1];
  const input = okBlock?.querySelector("input.objinfo-input");
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  ).set;
  setter.call(input, "5");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  input.blur();
  return true;
});
await new Promise((r) => setTimeout(r, 250));
const heightAfter = await p.evaluate(
  () =>
    [...document.querySelectorAll(".objinfo-field")]
      .find((f) => f.querySelector(".objinfo-flabel")?.textContent === "Höhe")
      ?.querySelector(".objinfo-fval")?.textContent || "",
);
await p.screenshot({ path: "scripts/probe-wallattr-3-ok-custom.png" });

// 3D (Isometrie) umschalten und Screenshot — der Umschalter ist ein Icon-Button
// mit title „Isometrie …" in der Oberleiste (kein Tab).
await p.evaluate(() => {
  const el = [...document.querySelectorAll("button[title]")].find((b) =>
    (b.getAttribute("title") || "").startsWith("Isometrie"),
  );
  el?.click();
});
await new Promise((r) => setTimeout(r, 1000));
await p.screenshot({ path: "scripts/probe-wallattr-4-3d.png" });

console.log(
  JSON.stringify(
    {
      tabOk,
      selected,
      hasWallSection,
      hasRefDropdown,
      refPicked,
      beforeRef,
      afterRef,
      footprintShifted: beforeRef.minY !== afterRef.minY || beforeRef.maxY !== afterRef.maxY,
      okCustom,
      setZ,
      heightBefore,
      heightAfter,
      errs,
    },
    null,
    2,
  ),
);
await b.close();
