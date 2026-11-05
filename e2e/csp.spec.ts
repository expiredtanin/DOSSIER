// [117] Strikte CSP (Meta-Tag im Build, s. vite.config.ts / scripts/csp.cjs): Musterhaus öffnen, Plan, Schnitt,
// Ansicht und 3D besuchen — es darf keine CSP-Verletzung geben (Konsole oder securitypolicyviolation).
import { discardIfAsked, expect, fileMenu, showSnapshot, startNewProject, test } from "./app";

test("keine CSP-Verletzung bei Plan, Schnitt, Ansicht und 3D", async ({ page }) => {
  test.setTimeout(120_000);
  const violations: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|violates the following|^CSPV /i.test(t)) violations.push(t.slice(0, 300));
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.warn(`CSPV ${e.violatedDirective} ${e.blockedURI}`);
    });
  });

  await startNewProject(page);
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(), "CSP-Meta-Tag im Build").toBe(1);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });

  for (const name of ["Schnitt A-A", "Ansicht Süd"]) {
    await showSnapshot(page, name);
    await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });
  }
  await page.getByRole("button", { name: "Axonometrie", exact: true }).click();
  await expect(page.getByText(/^Perspektive · /)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Grundriss", exact: true }).click();
  await expect(page.locator("svg.plan-svg").first()).toBeVisible({ timeout: 30_000 });

  expect(violations).toEqual([]);
});
