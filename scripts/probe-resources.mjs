// Probe für die Migration auf Component/HatchStyle/LineStyle + den Ressourcen-
// Manager. Erfasst (deviceScaleFactor 2, headless, SwiftShader) vier Zustände:
//
//   (a) Standard-App: EG-Grundriss (mehrschichtige Wände, Schraffuren, saubere
//       Ecken, Tür) — beweist, dass die Modell-Migration das Verhalten erhält.
//   (b) Ressourcen-Manager → Tab „Bauteile": Liste der Components MIT ihren
//       joinPriority-Werten.
//   (c) Live-Edit: Farbe eines Bauteils (Backstein) ändern → der Grundriss
//       aktualisiert sich live auf die neue Farbe (Vorher/Nachher + DOM-Fills).
//   (d) Tab „Schraffuren" und Tab „Linien" mit editierbaren Feldern.
//
// Aufruf: node scripts/probe-resources.mjs
// Hinweis: networkidle-GOTO-Timeout wird ignoriert (Vite-HMR hält Verbindungen
// offen); wir warten stattdessen auf konkrete DOM-Knoten.
import puppeteer from "puppeteer";

const URL = process.env.PROBE_URL || "http://localhost:5173/";
const OUT = "scripts";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1360, height: 900, deviceScaleFactor: 2 });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Klick auf das Element, dessen Textinhalt `text` enthält (innerhalb selector).
async function clickByText(selector, text) {
  const handle = await page.evaluateHandle(
    (sel, t) =>
      [...document.querySelectorAll(sel)].find((el) =>
        el.textContent.includes(t),
      ),
    selector,
    text,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`Element nicht gefunden: ${selector} ~ "${text}"`);
  await el.click();
}

// Setzt den Wert eines Inputs so, dass Reacts onChange feuert.
async function setInputValue(elHandle, value) {
  await page.evaluate(
    (el, v) => {
      const proto =
        el.type === "color"
          ? window.HTMLInputElement.prototype
          : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    elHandle,
    value,
  );
}

// Liest die Füllfarben aller Grundriss-Polygone (Component-Poché) + Anzahl.
const planFills = () =>
  page.evaluate(() => {
    const polys = [...document.querySelectorAll(".plan-svg polygon")];
    const fills = polys
      .map((p) => p.getAttribute("fill"))
      .filter((f) => f && !f.startsWith("url("));
    const patterns = [...document.querySelectorAll(".plan-svg defs pattern")]
      .length;
    const arcs = document.querySelectorAll(".plan-svg .door-swing").length;
    const leaves = document.querySelectorAll(".plan-svg .door-leaf").length;
    return {
      polyCount: polys.length,
      fills,
      uniqueFills: [...new Set(fills)],
      patternDefs: patterns,
      doorArcs: arcs,
      doorLeaves: leaves,
    };
  });

// Liest die Bauteil-Tabelle des Managers: Name + joinPriority je Zeile.
const componentRows = () =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll(".res-list .res-row")];
    return rows.map((r) => {
      const name = r.querySelector('input[type="text"]')?.value ?? null;
      const prio = r.querySelector(".res-prio input")?.value ?? null;
      const color = r.querySelector('input[type="color"]')?.value ?? null;
      const hatch =
        r.querySelector("select")?.selectedOptions?.[0]?.textContent ?? null;
      return { name, joinPriority: prio, color, hatch };
    });
  });

// Liest die aktiven Tab-Beschriftungen + welcher Tab aktiv ist.
const tabState = () =>
  page.evaluate(() => {
    const tabs = [...document.querySelectorAll(".res-tab-btn")].map((b) => ({
      label: b.textContent.trim(),
      active: b.classList.contains("active"),
    }));
    const rowCount = document.querySelectorAll(".res-list .res-row").length;
    const fieldLabels = [
      ...document.querySelectorAll(".res-list .res-row:first-child .res-field-label"),
    ].map((s) => s.textContent.trim());
    const inputCount = document.querySelectorAll(
      ".res-list .res-row:first-child input, .res-list .res-row:first-child select",
    ).length;
    return { tabs, rowCount, firstRowFieldLabels: fieldLabels, firstRowInputCount: inputCount };
  });

try {
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 8000 });
} catch (e) {
  logs.push(`[GOTO-INFO ignoriert] ${e.message}`);
}

// Auf den gerenderten Grundriss warten (statt networkidle).
await page.waitForSelector(".plan-svg polygon", { timeout: 15000 });
await sleep(500);

// ── (a) Standard: EG-Grundriss ──────────────────────────────────────────────
const fillsBefore = await planFills();
logs.push("(a) PLAN-VORHER " + JSON.stringify(fillsBefore));
await page.screenshot({ path: `${OUT}/probe-resources-a-grundriss.png` });

// ── (b) Ressourcen-Manager öffnen → Bauteile-Tab ────────────────────────────
await clickByText(".res-trigger", "Ressourcen");
await page.waitForSelector(".res-drawer", { timeout: 8000 });
await page.waitForSelector(".res-list .res-row", { timeout: 8000 });
await sleep(300);
logs.push("(b) TAB " + JSON.stringify(await tabState()));
logs.push("(b) BAUTEILE " + JSON.stringify(await componentRows()));
await page.screenshot({ path: `${OUT}/probe-resources-b-bauteile.png` });

// ── (c) Live-Edit: Backstein-Farbe auf knalliges Magenta ────────────────────
// Backstein-Zeile finden (Name-Textfeld == "Backstein"), dessen color-Input setzen.
const NEW_COLOR = "#ff00cc";
const colorHandle = await page.evaluateHandle((target) => {
  const row = [...document.querySelectorAll(".res-list .res-row")].find(
    (r) => r.querySelector('input[type="text"]')?.value === target,
  );
  return row?.querySelector('input[type="color"]') ?? null;
}, "Backstein");
if (!colorHandle.asElement())
  throw new Error("Backstein-Farbfeld nicht gefunden");
await setInputValue(colorHandle.asElement(), NEW_COLOR);
await sleep(300);
logs.push("(c) BAUTEILE-NACH-EDIT " + JSON.stringify(await componentRows()));

// Screenshot mit offenem Manager (zeigt neuen Swatch im Manager).
await page.screenshot({ path: `${OUT}/probe-resources-c1-manager-edit.png` });

// Manager schließen → Grundriss frei sichtbar, Live-Update prüfen.
await page.evaluate(() => {
  const overlay = document.querySelector(".res-overlay");
  // auf das Overlay (außerhalb der Schublade) klicken schließt den Manager
  overlay?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
// Falls der Overlay-Klick nicht griff, den ×-Knopf nutzen.
await sleep(200);
const stillOpen = await page.$(".res-drawer");
if (stillOpen) {
  await page.evaluate(() => document.querySelector(".res-close")?.click());
}
await page.waitForSelector(".res-drawer", { hidden: true, timeout: 5000 }).catch(() => {});
await sleep(400);

const fillsAfter = await planFills();
logs.push("(c) PLAN-NACHHER " + JSON.stringify(fillsAfter));
const colorApplied = fillsAfter.fills.includes(NEW_COLOR);
logs.push(
  `(c) LIVE-UPDATE ${colorApplied ? "OK" : "FEHLT"} — neue Farbe ${NEW_COLOR} ` +
    `${colorApplied ? "im" : "NICHT im"} Grundriss; ` +
    `uniqueFills vorher=${JSON.stringify(fillsBefore.uniqueFills)} ` +
    `nachher=${JSON.stringify(fillsAfter.uniqueFills)}`,
);
await page.screenshot({ path: `${OUT}/probe-resources-c2-plan-updated.png` });

// ── (d) Schraffuren-Tab und Linien-Tab ──────────────────────────────────────
await clickByText(".res-trigger", "Ressourcen");
await page.waitForSelector(".res-drawer", { timeout: 8000 });
await sleep(200);

await clickByText(".res-tab-btn", "Schraffuren");
await page.waitForSelector(".res-list .res-row", { timeout: 8000 });
await sleep(300);
logs.push("(d) SCHRAFFUREN " + JSON.stringify(await tabState()));
await page.screenshot({ path: `${OUT}/probe-resources-d1-schraffuren.png` });

await clickByText(".res-tab-btn", "Linien");
await page.waitForSelector(".res-list .res-row", { timeout: 8000 });
await sleep(300);
logs.push("(d) LINIEN " + JSON.stringify(await tabState()));
await page.screenshot({ path: `${OUT}/probe-resources-d2-linien.png` });

console.log(logs.join("\n"));
await browser.close();
