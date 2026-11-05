// [136] Zeichnungs-Reiter und Ausschnitte sind entkoppelt: mehrere Reiter aus einem Ausschnitt, Schliessen
// löscht keinen Ausschnitt, gelöschter Ausschnitt lässt seinen Reiter offen.
import {
  discardIfAsked,
  drawingTab,
  drawingTabs,
  expect,
  fileMenu,
  openSnapshotInNewTab,
  showSnapshot,
  snapshotRow,
  startNewProject,
  test,
} from "./app";

test("Reiter: mehrere aus einem Ausschnitt, schliessen behält den Ausschnitt", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });

  const tabs = drawingTabs(page).getByRole("tab");
  await expect(tabs).toHaveCount(1);

  // Klick im Panel: aktiver Reiter zeigt den Ausschnitt (kein neuer Reiter).
  await showSnapshot(page, "Schnitt A-A");
  await expect(tabs).toHaveCount(1);
  await expect(drawingTab(page, "Schnitt A-A")).toHaveAttribute("aria-selected", "true");

  // Zweimal derselbe Ausschnitt in neuen Reitern.
  await openSnapshotInNewTab(page, "EG 1:100");
  await openSnapshotInNewTab(page, "EG 1:100");
  await expect(tabs).toHaveCount(3);
  await expect(drawingTab(page, "EG 1:100")).toHaveCount(2);

  // Reiter schliessen: Ausschnitt bleibt im Panel.
  await page.getByRole("button", { name: "Reiter „EG 1:100\" schliessen" }).first().click();
  await expect(tabs).toHaveCount(2);
  await expect(await snapshotRow(page, "EG 1:100")).toBeVisible();

  // „+" öffnet einen weiteren Reiter mit der aktuellen Ansicht (kein Ausschnitt).
  await drawingTabs(page).getByRole("button", { name: "Neuer Reiter mit der aktuellen Ansicht" }).click();
  await expect(tabs).toHaveCount(3);

  // Ausschnitt im Panel löschen: sein Reiter bleibt offen, heisst weiter so und lässt sich wählen.
  await (await snapshotRow(page, "Schnitt A-A")).getByTitle("Löschen", { exact: true }).click();
  await expect(await snapshotRow(page, "Schnitt A-A")).toHaveCount(0);
  await expect(tabs).toHaveCount(3);
  await drawingTab(page, "Schnitt A-A").click();
  await expect(drawingTab(page, "Schnitt A-A")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
});
