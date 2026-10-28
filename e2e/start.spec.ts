import { expect, openTab, startNewProject, test, elementRows } from "./app";

test("App startet mit Startbildschirm", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Neues Projekt/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Projekt öffnen/ })).toBeVisible();
  await expect(page.getByText(/Version \d/)).toBeVisible();
});

test("Neues leeres Projekt: Arbeitsfläche, Werkzeuge, keine Bauteile", async ({ page }) => {
  await startNewProject(page);
  await expect(page.locator(".project-name")).toHaveText("Leeres Projekt");
  await expect(page.getByRole("button", { name: "Wand", exact: true })).toBeVisible();
  await openTab(page, "Elemente");
  await expect(page.getByText("Keine Bauteile im Projekt.")).toBeVisible();
  await expect(elementRows(page)).toHaveCount(0);
});
