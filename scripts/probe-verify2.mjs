import puppeteer from "puppeteer";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: 2 });
const errs = [];
page.on("pageerror", (e) => errs.push(`[PAGEERROR] ${e.message}`));
try { await page.goto("http://localhost:5173/", { waitUntil: "networkidle0", timeout: 20000 }); } catch {}
await new Promise((r) => setTimeout(r, 1200));

const footerScale = () => page.evaluate(() => {
  const t = document.body.innerText;
  const m = t.match(/MASSSTAB\s*(1:\d+)/i);
  return m ? m[1] : "?";
});

const before = await footerScale();
// Massstab-Select auf 1:50 setzen
const changed = await page.evaluate(() => {
  const selects = [...document.querySelectorAll("select")];
  for (const s of selects) {
    const opt = [...s.options].find((o) => /1:50\b/.test(o.textContent || o.value));
    if (opt) {
      s.value = opt.value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
  }
  return false;
});
await new Promise((r) => setTimeout(r, 500));
const after = await footerScale();

// Ressourcen öffnen
const resOpened = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /Ressourcen/i.test(x.textContent || ""));
  if (b) { b.click(); return true; }
  return false;
});
await new Promise((r) => setTimeout(r, 500));
const resInfo = await page.evaluate(() => {
  const ov = document.querySelector(".res-drawer, .res-overlay, [class*=overlay], [class*=drawer]");
  const z = ov ? getComputedStyle(ov).zIndex : null;
  return { hasOverlay: !!ov, z };
});
await page.screenshot({ path: "scripts/probe-ressourcen-window.png" });

console.log("Massstab-Select gefunden:", changed);
console.log("Footer Massstab vorher:", before, "→ nachher:", after, after !== before ? "✅ ändert sich" : "⚠️ gleich");
console.log("Ressourcen geöffnet:", resOpened, "Overlay:", resInfo.hasOverlay, "z-index:", resInfo.z);
console.log("PageErrors:", errs.length ? errs.join("\n") : "keine");
await browser.close();
