// Publikationssätze [79], PDF-Ebenen [80], Legenden [82]: ein Projekt mit Blatt (Viewport + Legende) und
// einem Publikationssatz wird geladen; „Publizieren" liefert das PDF (mit Ebenen), erhöht den Index und
// schreibt das Protokoll; das Blatt zeigt die Legende. Ergebnisse als PNG/PDF in test-results/ zum Ansehen.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { discardIfAsked, expect, fileMenu, openTab, startNewProject, test } from "./app";
import { BEISPIEL_OBP } from "./paths";

interface Cat {
  code: string;
  children?: Cat[];
}
const codesOf = (cs: Cat[]): string[] => cs.flatMap((c) => [c.code, ...codesOf(c.children ?? [])]);

async function projectWithSheet(): Promise<Buffer> {
  const j = JSON.parse(await readFile(BEISPIEL_OBP, "utf8"));
  const level = j.drawingLevels.find((l: { kind: string }) => l.kind === "floor");
  j.viewSnapshots = [
    {
      id: "s1",
      name: "EG 1:100",
      viewType: "plan",
      scaleDenominator: 100,
      detail: "fein",
      activeLevelId: level.id,
      layerVisibility: Object.fromEntries(codesOf(j.layers).map((c) => [c, true])),
      drawingVisibility: {},
    },
  ];
  j.masterLayouts = [{ id: "m1", name: "A3", paper: "a3", orientation: "landscape", titleBlock: { author: "KG" }, border: true }];
  j.layouts = [
    {
      id: "l1",
      name: "Grundriss EG",
      paper: "a3",
      orientation: "landscape",
      masterId: "m1",
      planNumber: "101",
      revision: "A",
      viewports: [{ id: "v1", snapshotId: "s1", xMm: 15, yMm: 15, widthMm: 270, heightMm: 250 }],
      legends: [{ id: "g1", xMm: 295, yMm: 15 }],
    },
  ];
  j.drawingLevels.push({ id: "sheet-l1", name: "Grundriss EG", kind: "drawing", visible: true, locked: false, layoutId: "l1" });
  j.projectNumber = "2026-14";
  j.publishSets = [{ id: "p1", name: "Baueingabe", layoutIds: ["l1"], bumpRevision: true, pdfLayers: true }];
  return Buffer.from(JSON.stringify(j));
}

async function load(page: Page): Promise<void> {
  await startNewProject(page);
  const chooser = page.waitForEvent("filechooser");
  await fileMenu(page, "Projekt öffnen");
  await (await chooser).setFiles({ name: "publikation.obp", mimeType: "application/json", buffer: await projectWithSheet() });
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toBeVisible();
  await openTab(page, "Mappe");
}

test("Blatt zeigt die Legende der Viewports", async ({ page }) => {
  await load(page);
  await page.locator(".nav-row", { hasText: "Grundriss EG" }).first().dblclick();
  await expect(page.locator(".layout-sheet-pane")).toBeVisible();
  const legend = page.locator("[data-legend-id=g1] svg");
  await expect(legend).toHaveCount(1, { timeout: 8000 });
  await expect(legend.locator("text").first()).toHaveText("Legende");
  // Mindestens ein Material mit Namen in der Legende.
  await expect.poll(async () => legend.locator("text").count()).toBeGreaterThan(2);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/legend-sheet.png" });
});

test("Satz publizieren: PDF mit Ebenen, Index erhöht, Protokoll", async ({ page }) => {
  await load(page);
  await expect(page.locator("[data-publish-set=p1]")).toBeVisible();
  const pending = page.waitForEvent("download");
  await page.locator("[data-publish-set=p1] [data-publish-run]").click();
  const dl = await pending;
  expect(dl.suggestedFilename()).toBe("Baueingabe.pdf");
  const bytes = await readFile(await dl.path());
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const text = bytes.toString("latin1");
  expect(text).toContain("/OCProperties");
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/publish-set.pdf", bytes);
  // Index A → B und Protokoll.
  await expect(page.locator("[data-publish-log]")).toContainText("Baueingabe");
  await expect(page.locator("[data-publish-log]")).toContainText("Index B");
  await page.screenshot({ path: "test-results/publish-panel.png" });
});
