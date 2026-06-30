import puppeteer from "puppeteer";

// Wie probe.mjs, aber klickt zusätzlich die Zeichnungsebene "Grundriss OG"
// im Navigator und schießt scripts/probe-doc.png.
const URL = process.env.PROBE_URL || "http://localhost:5173/";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

try {
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 20000 });
} catch (e) {
  logs.push(`[GOTO-ERROR] ${e.message}`);
}

// Navigator-Zeile "Grundriss OG" anklicken.
const clicked = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".nav-row")];
  const target = rows.find((r) => r.textContent.includes("Grundriss OG"));
  if (target) {
    target.click();
    return true;
  }
  return false;
});
logs.push(clicked ? "[INFO] 'Grundriss OG' geklickt" : "[WARN] 'Grundriss OG' nicht gefunden");

await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: "scripts/probe-doc.png" });

const info = await page.evaluate(() => {
  const title = document.querySelector(".content-single .pane-title")?.textContent ?? "none";
  const caption = document.querySelector(".content-single .plan-legend")?.textContent ?? "none";
  const polygons = document.querySelectorAll(".content-single .plan-svg polygon").length;
  return { title, caption, polygons };
});

console.log("=== Drawing-Layer-Ansicht ===", JSON.stringify(info));
console.log("\n=== Logs ===");
console.log(logs.length ? logs.join("\n") : "(keine)");
await browser.close();
