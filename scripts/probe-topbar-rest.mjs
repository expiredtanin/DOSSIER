import puppeteer from "puppeteer";

const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const p = await b.newPage();
await p.setViewport({ width: 1500, height: 220, deviceScaleFactor: 3 });
await p
  .goto("http://localhost:5187/", { waitUntil: "networkidle0", timeout: 20000 })
  .catch(() => {});
await new Promise((r) => setTimeout(r, 800));

// Helfer: Button per Tooltip-Anfang finden (title beginnt mit Text).
const findByTitle = (frag) =>
  p.evaluateHandle((f) => {
    const els = [...document.querySelectorAll("button[title]")];
    return els.find((e) => e.getAttribute("title")?.startsWith(f)) || null;
  }, frag);

const snap = async (file) => {
  const tb = await p.$(".topbar");
  const box = await tb.boundingBox();
  await p.screenshot({
    path: `scripts/${file}`,
    clip: { x: 0, y: 0, width: 1500, height: Math.ceil(box.height) + 8 },
  });
};

// Aktuellen Zustand der iconisierten Steuerungen lesen.
const state = () =>
  p.evaluate(() => {
    const byTitle = (f) =>
      [...document.querySelectorAll("button[title]")].find((e) =>
        e.getAttribute("title")?.startsWith(f),
      );
    const ref = byTitle("Referenzlinien");
    const res = byTitle("Ressourcen");
    const icons = [...document.querySelectorAll("button .material-symbols-outlined.tb-ico")].map(
      (s) => s.textContent,
    );
    return {
      refIcon: ref?.querySelector(".tb-ico")?.textContent,
      refActive: ref?.classList.contains("active") ?? null,
      resIcon: res?.querySelector(".tb-ico")?.textContent,
      resActive: res?.classList.contains("active") ?? null,
      lineModeIcons: [
        ...document.querySelectorAll(".view-btn-ico .tb-ico"),
      ].map((s) => s.textContent),
      allTbIcons: icons,
    };
  });

console.log("INITIAL:", JSON.stringify(await state()));
await snap("probe-topbar-rest-1-initial.png");

// Ressourcen-Toggle einschalten (öffnet die Schublade) → aktiver Zustand.
const res = await findByTitle("Ressourcen");
if (res && (await res.evaluate((e) => !!e))) {
  await res.click();
  await new Promise((r) => setTimeout(r, 500));
}
console.log("AFTER RES TOGGLE:", JSON.stringify(await state()));
await snap("probe-topbar-rest-2-res-active.png");

// Kamera-Popover öffnen (Perspektive nötig — erst auf Perspektive schalten).
const iso = await findByTitle("Isometrie");
if (iso && (await iso.evaluate((e) => !!e))) {
  await iso.click();
  await new Promise((r) => setTimeout(r, 400));
}
const cam = await findByTitle("Kamera");
if (cam && (await cam.evaluate((e) => !!e))) {
  await cam.click();
  await new Promise((r) => setTimeout(r, 400));
}
const popoverOpen = await p.evaluate(() => !!document.querySelector(".tb-popover"));
console.log("CAMERA POPOVER OPEN:", popoverOpen);
await snap("probe-topbar-rest-3-popover.png");

await b.close();
