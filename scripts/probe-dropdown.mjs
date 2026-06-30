import puppeteer from "puppeteer";
const PORT = process.env.PORT || "5173";
const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 420, deviceScaleFactor: 2 });
await p.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle0", timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 800));

// Detailgrad-Dropdown finden (Trigger mit aria-label = Detailgrad-Hint) und öffnen.
// Wir klicken den Trigger in der Detailgrad-Gruppe.
const opened = await p.evaluate(() => {
  const groups = [...document.querySelectorAll(".tb-group")];
  const detailGroup = groups.find((g) =>
    (g.getAttribute("aria-label") || "").includes("Detailgrad"),
  );
  const trig = detailGroup?.querySelector(".tb-dd-trigger");
  if (!trig) return { ok: false };
  trig.click();
  return { ok: true, label: trig.textContent };
});
await new Promise((r) => setTimeout(r, 250));

const info = await p.evaluate(() => {
  const menu = document.querySelector(".tb-dd-menu");
  if (!menu) return { menu: false };
  const cs = getComputedStyle(menu);
  const items = [...menu.querySelectorAll(".tb-dd-item")].map((it) => ({
    label: it.querySelector(".ctx-item-label")?.textContent,
    active: it.getAttribute("aria-selected") === "true",
    isActive: it.classList.contains("is-active"),
  }));
  return {
    menu: true,
    bg: cs.backgroundColor,
    radius: cs.borderRadius,
    items,
  };
});
const stillOpen = await p.evaluate(() => !!document.querySelector(".tb-dd-menu"));
console.log(JSON.stringify({ opened, info, stillOpen }, null, 2));

// Mount-Animation (ctx-pop) für den Screenshot deaktivieren, damit das Popover
// im Headless-Capture sicher voll deckend gerendert ist.
await p.addStyleTag({ content: ".tb-dd-menu{animation:none !important;}" });
await new Promise((r) => setTimeout(r, 120));
await p.screenshot({ path: "scripts/probe-dropdown.png", clip: { x: 0, y: 0, width: 1400, height: 320 } });
await b.close();
