import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
const errs = [];
page.on("pageerror", (e) => errs.push(`[PAGEERROR] ${e.message}`));
try { await page.goto("http://localhost:5173/", { waitUntil: "networkidle0", timeout: 20000 }); }
catch { /* networkidle timeout ok */ }
await new Promise((r) => setTimeout(r, 1200));

// 1) Plan zoom: wheel-in over the plan center, then screenshot
const svg = await page.$(".plan-svg");
if (svg) {
  const box = await svg.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel({ deltaY: -600 });
  await new Promise((r) => setTimeout(r, 300));
}
await page.screenshot({ path: "scripts/probe-zoom.png" });

// 2) Open Ressourcen manager, screenshot the table
const opened = await page.evaluate(() => {
  const el = [...document.querySelectorAll("button, .res-trigger, [role=button]")]
    .find((b) => /Ressourcen/i.test(b.textContent || ""));
  if (el) { el.click(); return true; }
  return false;
});
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: "scripts/probe-rm.png" });

const info = await page.evaluate(() => ({
  managerOpen: !!document.querySelector(".res-drawer, .res-table, [class*=res-]"),
  hasTable: !!document.querySelector(".res-table, table, .res-thead"),
  triggerFound: [...document.querySelectorAll("button")].some((b)=>/Ressourcen/i.test(b.textContent||"")),
}));
console.log("opened trigger:", opened, JSON.stringify(info));
console.log("pageerrors:", errs.length ? errs.join("\n") : "none");
await browser.close();
