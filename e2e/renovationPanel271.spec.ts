// [271] Dock-Panel „Umbau“: Zeichen-Status Neu → neue Wand ist rot, Filter umschalten, Auswahl auf Abbruch setzen + Undo,
// Auswahl nach Status, Etappe anlegen/löschen (Rückfrage über Overlay-Dialog). Port: E2E_PORT=5193.
import { blurFocus, commandInput, expect, finishCommand, openTab, test, typeCommand } from "./app";

test.use({ viewport: { width: 1280, height: 800 } });

const RED = "#e3001b";
const YELLOW = "#ffd800";

test("Umbau-Panel: Zeichen-Status, Filter, Auswahl, Etappen ([271])", async ({ page }) => {
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  const ren = () => page.evaluate(() => window.__dossierTest!.renovation());
  const fills = () => page.evaluate(() => window.__dossierTest!.planFillColors());

  await openTab(page, "Umbau");
  const panel = page.getByTestId("renovation-dock");
  await expect(panel).toBeVisible();
  await page.screenshot({ path: "test-results/renovation271-panel-leer.png" });

  // Zeichen-Status Neu, dann eine Wand über die Befehlszeile.
  await panel.getByTestId("reno-draw-new").click();
  await expect.poll(async () => (await ren()).draw).toBe("new");
  await page.getByRole("button", { name: "Wand", exact: true }).click();
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  await typeCommand(page, "5,0");
  await finishCommand(page);
  await expect.poll(async () => Object.values((await ren()).walls)).toEqual(["new"]);

  // Filter Umbauplan: die neue Wand ist rot; Bestand-Filter blendet sie aus.
  await blurFocus(page);
  await panel.getByTestId("reno-filter-umbauplan").click();
  await expect.poll(async () => (await ren()).filter).toBe("umbauplan");
  await expect.poll(async () => Object.keys(await fills())).toContain(RED);
  await expect(panel.getByTestId("reno-chip-new")).toHaveAttribute("data-show", "override");
  await panel.getByTestId("reno-filter-bestand").click();
  await expect.poll(async () => Object.keys(await fills())).not.toContain(RED);
  await panel.getByTestId("reno-filter-umbauplan").click();

  // Auswahl: Wand wählen, auf Abbruch setzen (ein Undo-Schritt), Undo.
  const wallId = Object.keys((await ren()).walls)[0];
  await page.evaluate((id) => window.__dossierTest!.select({ walls: [id] }), wallId);
  await expect(panel.getByTestId("reno-sel-state")).toHaveAttribute("data-status", "new");
  await panel.getByTestId("reno-set-demolish").click();
  await expect.poll(async () => (await ren()).walls[wallId]).toBe("demolish");
  await expect(panel.getByTestId("reno-sel-state")).toHaveAttribute("data-status", "demolish");
  await expect.poll(async () => Object.keys(await fills())).toContain(YELLOW);
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await ren()).walls[wallId]).toBe("new");

  // Nach Status wählen: Abbruch gibt es nicht (Knopf aus), Neu wählt die Wand.
  await page.evaluate(() => window.__dossierTest!.select({}));
  await expect(panel.getByTestId("reno-select-demolish")).toBeDisabled();
  await panel.getByTestId("reno-select-new").click();
  await expect(panel.getByTestId("reno-sel-state")).toHaveAttribute("data-status", "new");

  // Etappe anlegen, umbenennen; löschen mit Rückfrage (Abbrechen lässt sie stehen).
  await panel.getByTestId("reno-phase-add").click();
  await expect(panel.getByTestId("reno-phase-row")).toHaveCount(1);
  await panel.getByTestId("reno-phase-name").fill("Rohbau");
  await expect(panel.getByTestId("reno-phase-name")).toHaveValue("Rohbau");
  await panel.getByTestId("reno-phase-remove").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(panel.getByTestId("reno-phase-row")).toHaveCount(1);
  await panel.getByTestId("reno-phase-remove").click();
  await page.getByTestId("confirm-dialog-ok").click();
  await expect(panel.getByTestId("reno-phase-row")).toHaveCount(0);
});
