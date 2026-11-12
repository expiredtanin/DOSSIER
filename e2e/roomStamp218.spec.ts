// [218] Raumstempel bearbeiten ist kein Dialog im Fenster mehr: Doppelklick auf einen Stempel öffnet die
// Objekteinstellungen mit dem Abschnitt „Raumstempel“; Schrift (Familie, Grösse, fett, kursiv, Farbe) je Zeile;
// Bezugspunkt und Masse stehen nur im Objekt-Info-Panel. Mit SHOT_DIR=<ordner> entstehen Screenshots.
import type { Page } from "@playwright/test";
import { blurFocus, discardIfAsked, expect, fileMenu, test } from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

async function openComplex(page: Page): Promise<void> {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
}

/** Bildschirmlage eines Modellpunkts (Bildmitte + Zoom aus dem Test-Hook; Modell-y zeigt nach oben). */
async function screenOf(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const cam = await page.evaluate(() => window.__dossierTest!.viewCamera());
  const box = (await page.locator("svg.plan-svg").first().boundingBox())!;
  return { x: box.x + box.width / 2 + (x - cam.center!.x) * cam.pxPerMeter!, y: box.y + box.height / 2 - (y - cam.center!.y) * cam.pxPerMeter! };
}

test("Doppelklick auf Raumstempel: Objekteinstellungen mit Abschnitt Raumstempel, Schrift ändern, Undo ([218])", async ({ page }) => {
  test.setTimeout(150_000);
  await openComplex(page);
  await page.waitForTimeout(1500);
  const shots = process.env.SHOT_DIR;
  const rooms = await page.evaluate(() => window.__dossierTest!.roomCenters());
  expect(rooms.length).toBeGreaterThan(2);
  // Ein Raum, dessen Stempel im Plan steht (Wohnen o. Ä.): der grösste Name.
  let target = rooms[0];
  for (const r of rooms) {
    const st = await page.evaluate((id) => window.__dossierTest!.roomStamp(id), r.id);
    if (st) {
      target = r;
      break;
    }
  }
  const before = await page.evaluate((id) => window.__dossierTest!.roomStamp(id), target.id);
  expect(before?.name.sizePt).toBe(12);
  if (shots) await page.screenshot({ path: `${shots}/stempel-vorher.png` });

  // Kein Fenster im Fenster: weder Overlay-Dialog noch Objekteinstellungen vor dem Doppelklick.
  await expect(page.locator(".objset-panel")).toHaveCount(0);
  const at = await screenOf(page, target.x, target.y);
  await page.mouse.dblclick(at.x, at.y);

  const win = page.locator(".objset-panel");
  await expect(win).toBeVisible();
  await expect(page.locator(".texteditor-overlay")).toHaveCount(0);
  const group = win.locator('[data-group="roomStamp"]');
  await expect(group.locator(".objinfo-group-head")).toHaveAttribute("aria-expanded", "true");
  await expect(group.locator(".objinfo-group-head")).toBeFocused();
  // Bezugspunkt und Masse nur im Panel, nicht im Fenster.
  await expect(win.locator(".objinfo-cube")).toHaveCount(0);
  await expect(win.getByText("Bezugspunkt", { exact: true })).toHaveCount(0);

  // Schrift der Namenszeile: 24 pt, Jost, kursiv.
  const size = group.getByTestId("roomstamp-nameFont-size");
  await size.fill("24");
  await expect.poll(async () => (await page.evaluate((id) => window.__dossierTest!.roomStamp(id), target.id))?.name.sizePt).toBeGreaterThan(11);
  await group.getByTestId("roomstamp-nameFont-italic").click();
  const nameRow = group.getByTestId("roomstamp-font-nameFont");
  await nameRow.locator(".tb-dd-trigger").click();
  await page.getByRole("option", { name: "Jost", exact: true }).click();
  await expect.poll(async () => (await page.evaluate((id) => window.__dossierTest!.roomStamp(id), target.id))?.name.font).toBe("Jost");
  const after = await page.evaluate((id) => window.__dossierTest!.roomStamp(id), target.id);
  expect(after?.name.sizePt === 24 || (after?.name.sizePt ?? 0) > 12).toBe(true);
  // Zeile Fläche: grössere Schrift.
  await group.getByTestId("roomstamp-areaFont-size").fill("14");
  await expect.poll(async () => (await page.evaluate((id) => window.__dossierTest!.roomStamp(id), target.id))?.extra[0]?.marks?.sizePt).toBe(14);
  await page.waitForTimeout(2000);
  if (shots) {
    await page.screenshot({ path: `${shots}/stempel-nachher.png` });
    await group.locator(".objinfo-group-head").scrollIntoViewIfNeeded();
    await win.screenshot({ path: `${shots}/objekteinstellungen-raumstempel.png` });
  }

  // Undo (drei Schritte: Grösse + Schrift + Kursiv gehören zu getrennten Eingaben) → zurück auf die Vorgabe.
  await blurFocus(page);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Control+z");
    const cur = await page.evaluate((id) => window.__dossierTest!.roomStamp(id), target.id);
    if (cur?.name.sizePt === 12 && !cur.name.font && !cur.extra[0]?.marks) break;
  }
  const undone = await page.evaluate((id) => window.__dossierTest!.roomStamp(id), target.id);
  expect(undone?.name.sizePt).toBe(12);
  expect(undone?.name.font).toBeUndefined();
});
