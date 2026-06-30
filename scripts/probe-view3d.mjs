// Probe: belegt die Ansichts-3D-Presets (Front/Top/Seite/Persp./Iso) +
// Kamera-FOV. Wechselt in die Perspektive, klickt je Preset den Button und
// screenshotet. Die PNGs müssen sich deutlich unterscheiden.
//   probe-view3d-perspective.png  — 3/4-Blick
//   probe-view3d-top.png          — Draufsicht
//   probe-view3d-front.png        — frontal
//   probe-view3d-side.png         — seitlich
//   probe-view3d-iso.png          — isometrisch
//   probe-view3d-fov.png          — Kamera-Popover mit FOV-Regler (weit)
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (name) => page.screenshot({ path: `scripts/${name}` });

// In die Perspektive wechseln.
await clickByText("button.view-btn", "Perspektive");
await wait(1000);

// Default-Preset (perspective) — Referenz.
await shot("probe-view3d-perspective.png");

// Presets durchschalten (per sichtbarem Button-Text in der 3D-Gruppe).
for (const [label, file] of [
  ["Oben", "probe-view3d-top.png"],
  ["Front", "probe-view3d-front.png"],
  ["Seite", "probe-view3d-side.png"],
  ["Isometrie", "probe-view3d-iso.png"],
  ["Perspektive", "probe-view3d-perspective2.png"],
]) {
  await clickByText("button.view-btn", label);
  await wait(700);
  await shot(file);
}

// Kamera-Popover öffnen + FOV weit aufdrehen (sichtbarer Effekt).
await clickByText("button.tb-btn", "Kamera");
await wait(300);
const range = await page.$(".tb-popover input[type=range]");
if (range) {
  await page.evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(el, "90");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, range);
  await wait(500);
}
await shot("probe-view3d-fov.png");

console.log("Screenshots: probe-view3d-{perspective,top,front,side,iso,fov}.png");
console.log("\n=== Logs ===");
console.log(logs.length ? logs.join("\n") : "(keine)");
await browser.close();
