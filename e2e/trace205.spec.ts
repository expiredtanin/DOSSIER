// [205] Pausfolie wie Archicad: Musterhaus komplex, EG-Grundriss, Schnitt A-A über das Navigator-Kontextmenü als
// Pausfolie einschalten → gedämpfte (gefärbte) Linien sichtbar und nicht anwählbar; mit `tracemove` verschieben;
// mit Ctrl+Shift+T aus. Headless zeichnet die SVG-Ansicht (kein WebGPU): sichtbar wird über die Pixel des
// Bildschirmfotos geprüft (Pausenfarbe Blau mit voller Deckkraft). Die WebGPU-/Metal-Wege sind hier nicht geprüft.
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, expect, fileMenu, openTab, test, typeCommand } from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

const BLUE = [0x20, 0x60, 0xc0];

/** Zahl der Pixel nahe der Pausenfarbe im Bildschirmfoto der Plan-Ansicht. */
async function bluePixels(page: Page, shot?: string): Promise<number> {
  const plan = page.locator("svg.plan-svg").first();
  const png = await plan.screenshot(shot ? { path: shot } : {});
  return page.evaluate(
    async ({ b64, rgb }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - rgb[0]) < 30 && Math.abs(d[i + 1] - rgb[1]) < 30 && Math.abs(d[i + 2] - rgb[2]) < 30) n++;
      return n;
    },
    { b64: png.toString("base64"), rgb: BLUE },
  );
}

const trace = (page: Page) => page.evaluate(() => window.__dossierTest!.trace());
const cam = (page: Page) => page.evaluate(() => window.__dossierTest!.viewCamera());

test("Schnitt A-A als Pausfolie hinter dem EG: sichtbar, nicht anwählbar, verschiebbar, aus", async ({ page }) => {
  test.setTimeout(180_000);
  const dir = process.env.SHOT_DIR;
  // SVG-Ansicht erzwingen (`gl=0`): headless liefert die WebGPU-Fläche kein Bild.
  await page.goto("/?dossierTest&gl=0");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await openTab(page, "Zeichnungsebenen");
  const nav = (name: string) => page.locator(".nav-row").filter({ hasText: name }).first();
  await nav("Erdgeschoss").click();
  const plan = page.locator("svg.plan-svg").first();
  await expect(plan).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await cam(page)).levelId).toBe("eg");
  expect((await trace(page)).n).toBe(0);

  // Navigator: Rechtsklick auf „Schnitt A-A" → „Als Pausfolie zeigen".
  await nav("Schnitt A-A").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Als Pausfolie zeigen" }).click();
  await expect.poll(async () => (await trace(page)).n).toBeGreaterThan(20);
  const t0 = await trace(page);
  // Der aktive Reiter bleibt der EG-Grundriss; die Pause trägt keine Auswahl-Ids, nur eine (gedämpfte) Farbe.
  expect((await cam(page)).levelId).toBe("eg");
  expect(t0.withIds).toBe(0);
  expect(t0.colors.length).toBe(1);

  // Statusleiste: Farbe Blau, volle Deckkraft (dann ist die Pause im Bild eindeutig zu erkennen).
  await page.locator('button[aria-label="Pausfolie einstellen"]').click();
  await page.getByRole("dialog", { name: "Pausfolie einstellen" }).getByLabel("Farbe").selectOption({ label: "Blau" });
  await page.getByRole("dialog", { name: "Pausfolie einstellen" }).getByLabel("Deckkraft").fill("100");
  await expect.poll(async () => (await trace(page)).colors).toEqual(["#2060c0"]);
  await page.getByTestId("status-hint").click(); // Popover schliessen (Klick ausserhalb)
  await expect(page.getByRole("dialog", { name: "Pausfolie einstellen" })).toHaveCount(0);

  // Herauszoomen, bis die (links neben dem Grundriss aufgeklappte) Pause im Bild ist.
  await blurFocus(page);
  const box = (await plan.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // [204] Der Start-Zoom passt seit dem Gebäude-Einpassen enger (1:121 statt 1:375): mehr Schritte heraus.
  for (let i = 0; i < 20; i++) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(800);
  const seen = await bluePixels(page, dir ? `${dir}/trace-eg-schnitt-a.png` : undefined);
  expect(seen, "Pausenlinien im Bild").toBeGreaterThan(200);

  // Nicht anwählbar: Klick mitten auf die längste Pausen-Linie wählt nichts.
  const { probe } = await trace(page);
  const c = await cam(page);
  expect(probe && c.center && c.pxPerMeter).toBeTruthy();
  const at = { x: box.x + box.width / 2 + (probe!.x - c.center!.x) * c.pxPerMeter!, y: box.y + box.height / 2 - (probe!.y - c.center!.y) * c.pxPerMeter! };
  expect(at.x > box.x && at.x < box.x + box.width && at.y > box.y && at.y < box.y + box.height, "Klickziel im Bild").toBe(true);
  // Die Pause bringt nichts Anwählbares: derselbe Klick wählt mit und ohne Pause dasselbe (hier höchstens das
  // Achsraster des Modells, das dort durchläuft).
  const selectedAt = async () => {
    await page.keyboard.press("Escape");
    // Esc hebt die Auswahl verzögert auf ([204]); sonst trifft der Klick die noch gewählte Wand und schaltet weiter.
    await expect.poll(async () => (await page.evaluate(() => window.__dossierTest!.selected())).all).not.toMatch(/"[a-z]+":\["/);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(300);
    return (await page.evaluate(() => window.__dossierTest!.selected())).all;
  };
  const withTrace = await selectedAt();
  await blurFocus(page);
  await page.keyboard.press("Control+Shift+T");
  await expect.poll(async () => (await trace(page)).n).toBe(0);
  const withoutTrace = await selectedAt();
  expect(withTrace).toBe(withoutTrace);
  await page.keyboard.press("Escape");
  await blurFocus(page);
  await page.keyboard.press("Control+Shift+T");
  await expect.poll(async () => (await trace(page)).n).toBeGreaterThan(20);

  // Verschieben per Befehl: Basispunkt 0,0 → 4,0 (nur Anzeige, das Modell bleibt).
  const before = (await trace(page)).bounds!;
  const counts = await page.evaluate(() => window.__dossierTest!.counts());
  await typeCommand(page, "tracemove");
  await typeCommand(page, "0,0");
  await typeCommand(page, "4,0");
  await expect.poll(async () => ((await trace(page)).trace as { offset: { x: number } }).offset.x).toBeCloseTo(4, 6);
  const after = (await trace(page)).bounds!;
  expect(after.minX - before.minX).toBeCloseTo(4, 6);
  expect(await page.evaluate(() => window.__dossierTest!.counts())).toEqual(counts);
  await page.waitForTimeout(500);
  if (dir) await plan.screenshot({ path: `${dir}/trace-verschoben.png` });

  // Aus per Kürzel: keine Pause mehr im Bild, Einstellungen bleiben (wieder ein → gleiche Lage).
  await blurFocus(page);
  await page.keyboard.press("Control+Shift+T");
  await expect.poll(async () => (await trace(page)).n).toBe(0);
  await page.waitForTimeout(500);
  expect(await bluePixels(page, dir ? `${dir}/trace-aus.png` : undefined)).toBeLessThan(seen / 10);
  await page.keyboard.press("Control+Shift+T");
  await expect.poll(async () => (await trace(page)).n).toBeGreaterThan(20);
  expect(((await trace(page)).trace as { offset: { x: number } }).offset.x).toBeCloseTo(4, 6);
});
