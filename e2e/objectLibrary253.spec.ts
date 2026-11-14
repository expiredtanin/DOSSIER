// [253] Objektbibliothek 2D: Palette „Objekte" → Objekt wählen → Einfügepunkt klicken (R drehen, M spiegeln) →
// Objekt-Info baut die Felder aus der Parameterliste → Breite ändern, „Neu würfeln" → Undo nimmt das Setzen
// samt angelegter Klasse in einem Schritt zurück. Geprüft über die Test-Naht `libobjs` (Parameter, Plan-Ausmass).
import type { Page } from "@playwright/test";
import { blurFocus, expect, openTab, test } from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

const prompt = (page: Page) => page.locator(".cmdline-prompt");
const libobjs = (page: Page) => page.evaluate(() => window.__dossierTest!.libobjs());

/** Objekt in der Palette wählen (Gruppe bei Bedarf aufklappen), Optionstasten drücken, Einfügepunkt klicken. */
async function place(page: Page, group: string, name: string, dx: number, dy: number, keys: string[] = []): Promise<void> {
  await openTab(page, "Objekte");
  const btn = page.getByRole("button", { name, exact: true });
  if (!(await btn.isVisible())) await page.locator("summary", { hasText: group }).click();
  await btn.click();
  await expect(prompt(page)).toHaveText("Einfügepunkt:");
  for (const k of keys) {
    // R / M wie beim Zeichnen: Fokus auf der Fläche, nicht im Textfeld.
    await blurFocus(page);
    await page.keyboard.press(k);
  }
  const box = (await page.locator("canvas").first().boundingBox())!;
  const x = box.x + dx;
  const y = box.y + dy;
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await expect(prompt(page)).toHaveText("Befehl:");
}

test("Objektbibliothek: WC und Esstisch setzen, Parameter ändern, Undo", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  const before = await libobjs(page);
  expect(before.items).toHaveLength(0);

  // WC: einmal gedreht (R) und gespiegelt (M).
  await place(page, "Sanitär", "WC wandhängend", 250, 250, ["r", "m"]);
  let s = await libobjs(page);
  expect(s.items).toHaveLength(1);
  const wc = s.items[0];
  expect(wc.libId).toBe("lib:wc-wand");
  expect(wc.rotation).toBeCloseTo(Math.PI / 2, 6);
  expect(wc.params.mirror).toBe(true);
  expect(wc.lines).toBeGreaterThan(0);
  // Die Klasse des Objekts gibt es jetzt (im selben Schritt angelegt).
  expect(s.layers).toContain(wc.categoryCode);

  // Esstisch mit Stühlen: Drehung und Spiegelung bleiben erhalten → dreimal R und einmal M stellt sie zurück.
  await place(page, "Tische", "Tisch 80×140 mit Stühlen", 450, 250, ["r", "r", "r", "m"]);
  s = await libobjs(page);
  expect(s.items).toHaveLength(2);
  const table = s.items.find((o) => o.libId === "lib:tisch-80x140")!;
  expect(table).toBeTruthy();
  expect(table.rotation).toBeCloseTo(0, 6);
  expect(table.params.mirror).toBeUndefined();
  expect(table.lines).toBeGreaterThan(0);
  expect(table.categoryCode).not.toBe(wc.categoryCode);

  // Objekt-Info des Tischs: Felder aus der Parameterliste; Breite ändern → das Plan-Ausmass wächst.
  await page.evaluate((id) => window.__dossierTest!.select({ drawings: [id] }), table.id);
  await openTab(page, "Objekt-Info");
  const section = page.getByTestId("libobj-section");
  await expect(section).toContainText("Tisch 80×140 mit Stühlen");
  await expect(section.locator("label.objinfo-field", { hasText: "Stühle" })).toBeVisible();
  const width = section.locator("label.objinfo-field", { hasText: "Breite" }).locator("input");
  await expect(width).toHaveValue("1.400");
  await width.fill("2");
  await width.press("Enter");
  await expect.poll(async () => (await libobjs(page)).items.find((o) => o.id === table.id)!.params.w).toBeCloseTo(2, 6);
  const wider = (await libobjs(page)).items.find((o) => o.id === table.id)!;
  expect(wider.w, "Plan wird breiter").toBeGreaterThan(table.w + 0.4);

  // „Neu würfeln" ändert den Seed.
  const seed0 = wider.seed;
  await section.getByRole("button", { name: "Neu würfeln" }).click();
  await expect.poll(async () => (await libobjs(page)).items.find((o) => o.id === table.id)!.seed).not.toBe(seed0);

  // Undo, Schritt für Schritt: Seed, Breite, Tisch setzen (ein Schritt), WC samt Klasse setzen (ein Schritt).
  const undo = async () => {
    await blurFocus(page);
    await page.keyboard.press("ControlOrMeta+z");
  };
  await undo();
  await expect.poll(async () => (await libobjs(page)).items.find((o) => o.id === table.id)?.seed).toBe(seed0);
  await undo();
  await expect.poll(async () => (await libobjs(page)).items.find((o) => o.id === table.id)?.params.w).toBe(1.4);
  await undo();
  await expect.poll(async () => (await libobjs(page)).items.map((o) => o.libId)).toEqual(["lib:wc-wand"]);
  await undo();
  await expect.poll(async () => (await libobjs(page)).items).toHaveLength(0);
  // Die für das WC angelegte Klasse ist mit zurückgenommen.
  expect((await libobjs(page)).layers).toEqual(before.layers);
});

test("Objektbibliothek: aus der Palette in den Plan ziehen und loslassen", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?dossierTest&gl=0");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  expect((await libobjs(page)).items).toHaveLength(0);

  await openTab(page, "Objekte");
  const wc = page.getByRole("button", { name: "WC wandhängend", exact: true });
  if (!(await wc.isVisible())) await page.locator("summary", { hasText: "Sanitär" }).click();
  const canvas = (await page.locator("svg.plan-svg").first().boundingBox())!;
  const from = (await wc.boundingBox())!;
  const sx = from.x + from.width / 2;
  const sy = from.y + from.height / 2;

  // Ziehen und über der Fläche loslassen: ein Objekt, der Befehl ist beendet.
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await expect(prompt(page)).toHaveText("Einfügepunkt:");
  await page.mouse.move(canvas.x + 200, canvas.y + 200, { steps: 8 });
  await page.mouse.up();
  await expect(prompt(page)).toHaveText("Befehl:");
  let s = await libobjs(page);
  expect(s.items).toHaveLength(1);
  expect(s.items[0].libId).toBe("lib:wc-wand");

  // Loslassen ausserhalb der Fläche (zurück über der Palette): abgebrochen, nichts gesetzt.
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await expect(prompt(page)).toHaveText("Einfügepunkt:");
  await page.mouse.move(canvas.x + 300, canvas.y + 220, { steps: 6 });
  await page.mouse.move(sx + 2, sy + 40, { steps: 6 });
  await page.mouse.up();
  await expect(prompt(page)).toHaveText("Befehl:");
  expect((await libobjs(page)).items).toHaveLength(1);

  // Esc während des Ziehens bricht ab; das Loslassen über der Fläche setzt nichts.
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 320, canvas.y + 260, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(prompt(page)).toHaveText("Befehl:");
  expect((await libobjs(page)).items).toHaveLength(1);

  // Normaler Klick ohne Ziehen: Befehl läuft, Klick im Plan setzt.
  await wc.click();
  await expect(prompt(page)).toHaveText("Einfügepunkt:");
  await page.mouse.move(canvas.x + 400, canvas.y + 250);
  await page.mouse.click(canvas.x + 400, canvas.y + 250);
  await expect(prompt(page)).toHaveText("Befehl:");
  s = await libobjs(page);
  expect(s.items).toHaveLength(2);
});
