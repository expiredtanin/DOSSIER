import puppeteer from "puppeteer";
const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const p = await b.newPage();
await p.setViewport({ width: 1500, height: 220, deviceScaleFactor: 2 });
await p.goto("http://localhost:5187/", { waitUntil: "networkidle0", timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 900));

// Versuch: in eine Geschoss-/Grundriss-Ansicht wechseln, damit der Linien-Modus
// (nur im Grundriss) aktiv ist. Klick auf das erste "grundriss"-View-Icon.
const grund = await p.$('.view-icon[aria-label]');
const tb = await p.$(".topbar");
let box = await tb.boundingBox();
const H = Math.ceil(box.height) + 10;

// 1) Topbar im Ruhezustand.
await p.screenshot({ path: "scripts/probe-pills-1-topbar.png", clip: { x: 0, y: 0, width: 1500, height: H } });

// Diagnose: gibt es einen Linien-Modus-Dropdown-Trigger? (Label-Text.)
const diag = await p.evaluate(() => {
  const triggers = [...document.querySelectorAll(".tb-dd-trigger")].map((t) => t.textContent.trim());
  const btns = [...document.querySelectorAll(".tb-btn")].map((b) => ({
    text: b.textContent.trim(),
    radius: getComputedStyle(b).borderRadius,
    border: getComputedStyle(b).borderTopWidth,
    bg: getComputedStyle(b).backgroundColor,
  }));
  // Hat irgendein Dropdown die Linien-Modus-Werte Display/Print?
  return { triggers, btns };
});
console.log("TRIGGERS:", JSON.stringify(diag.triggers));
console.log("BTNS:", JSON.stringify(diag.btns, null, 0));

// 2) Linien-Modus-Dropdown öffnen (Tastatur, zuverlässig): Trigger mit Label
//    Display/Print fokussieren + Enter.
const sel = await p.evaluate(() => {
  const t = [...document.querySelectorAll(".tb-dd-trigger")].find((t) => {
    const tx = t.textContent.trim();
    return tx === "Display" || tx === "Print";
  });
  if (!t) return null;
  t.id = "linemode-trigger-probe";
  return "#linemode-trigger-probe";
});
console.log("LINEMODE DROPDOWN FOUND:", !!sel);
if (sel) {
  await p.focus(sel);
  await p.keyboard.press("Enter");
}
await new Promise((r) => setTimeout(r, 350));
// Vollbild, damit das (per Portal an body) gerenderte Popover sichtbar ist.
await p.screenshot({ path: "scripts/probe-pills-2-linemode-open.png" });

// Popover-Inhalt prüfen (Optionen + Häkchen).
const pop = await p.evaluate(() => {
  const menu = document.querySelector(".tb-dd-menu");
  if (!menu) return null;
  const items = [...menu.querySelectorAll(".tb-dd-item")].map((i) => ({
    label: i.querySelector(".ctx-item-label")?.textContent.trim(),
    checked: !!i.querySelector(".tb-dd-check"),
  }));
  return items;
});
console.log("LINEMODE OPTIONS:", JSON.stringify(pop));

// Menü schließen.
await p.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 200));

// 3) Hover über die erste Aktions-Pille (z. B. 100%), Hover-Optik zeigen.
const hovered = await p.evaluate(() => {
  const btn = document.querySelector(".tb-btn:not(:disabled)");
  if (!btn) return null;
  btn.scrollIntoView({ block: "center", inline: "center" });
  return true;
});
const firstBtn = await p.$(".tb-btn");
if (firstBtn) {
  const bb = await firstBtn.boundingBox();
  if (bb) await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
}
await new Promise((r) => setTimeout(r, 250));
box = await tb.boundingBox();
await p.screenshot({ path: "scripts/probe-pills-3-btn-hover.png", clip: { x: 0, y: 0, width: 1500, height: Math.ceil(box.height) + 10 } });
console.log("HOVERED BTN:", hovered);

await b.close();
