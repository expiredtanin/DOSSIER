// [208] Wettbewerbs-Abgabe: Blatt A1 quer aus der Plakat-Vorlage (Raster, Kopfzeile mit Kennwort, Massstab je
// Viewport), Bild aufs Blatt setzen (Zuschnitt, Auflösung), anonyme Abgabe mit Kennwort und der Satz
// „WBW-Abgabe" → ein PDF ohne Büro-/Autor-Metadaten. Mit DOSSIER_SHOTS=<ordner> entstehen PDF und Screenshot.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { expect, openSample, openTab, startNewProject, test } from "./app";

/** PNG (Verlauf, Standard 160 × 90 px), im Test erzeugt: kein Fixture, nur die Pflicht-Chunks. */
function testPng(w = 160, h = 90): Buffer {
  const crc = (buf: Buffer): number => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // Bits
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = Math.round((x / w) * 200);
      raw[row + 2 + x * 3] = Math.round(120 + (y / h) * 100);
      raw[row + 3 + x * 3] = 200 - Math.round((y / h) * 120);
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

/** Text aller Inhaltsströme eines PDFs (Flate entpackt). */
function pdfStreams(buf: Buffer): string {
  const src = buf.toString("latin1");
  let out = src;
  for (const m of src.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = src.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      out += inflateSync(buf.subarray(start, end)).toString("latin1");
    } catch {
      /* kein Flate-Strom */
    }
  }
  return out;
}

async function paperBox(page: Page) {
  return (await page.locator("[data-sheet-backdrop] > rect").nth(1).boundingBox())!;
}

test("Plakat A1 quer aus Vorlage, Bild einsetzen, anonym als WBW-Abgabe exportieren", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);

  // Ausschnitt „EG" für den Viewport.
  await openTab(page, "Ausschnitte");
  await page.getByTitle("Ausschnitt speichern").first().click();
  await page.getByPlaceholder("Ausschnitt speichern als:").fill("EG");
  await page.keyboard.press("Enter");

  // Neues Layout aus der Plakat-Vorlage A1 quer.
  await openTab(page, "Mappe");
  await page.getByRole("button", { name: "Layout erstellen" }).first().click();
  await page.locator("[data-testid=newlayout-poster]").check();
  await expect(page.locator("[data-testid=newlayout-poster-select]")).toHaveValue("poster-a1-landscape");
  await page.getByRole("button", { name: "Erstellen", exact: true }).click();
  await page.keyboard.press("Enter");
  await page.locator(".nav-row", { hasText: "Layout" }).first().dblclick();
  await expect(page.locator(".layout-sheet-pane")).toBeVisible();

  // Blatt: A1 quer (841 : 594), Kopfzeile mit Kennwort-Feld, Hilfslinien des Gestaltungsrasters.
  const paper = await paperBox(page);
  expect(paper.width / paper.height).toBeCloseTo(841 / 594, 2);
  await expect(page.locator("[data-poster-header]")).toBeAttached();
  await expect(page.locator("[data-poster-header] text").first()).toHaveText("Kennwort");
  await expect(page.locator("[data-poster-header] text").last()).toHaveText("Plan 1/1");
  expect(await page.locator("[data-guides] line").count()).toBe(16); // 6 Spalten × 2 + 4 waagrechte

  // Viewport aufziehen: Massstabsangabe darunter.
  await page.getByRole("button", { name: /Viewport aufziehen/ }).click();
  const a = { x: paper.x + paper.width * 0.03, y: paper.y + paper.height * 0.16 };
  const b = { x: paper.x + paper.width * 0.5, y: paper.y + paper.height * 0.8 };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  const bind = page.locator(".layout-sheet-bind select");
  if (await bind.isVisible().catch(() => false)) await bind.selectOption({ label: "EG" });
  await expect(page.locator("[data-viewport-id] svg").first()).toBeAttached();
  await expect(page.locator("[data-scale-label]").first()).toHaveText(/^1:\d+$/);

  // Bild einsetzen (PNG), mittig im Seitenverhältnis; Auflösung und Zuschnitt im HUD.
  await page.locator("[data-testid=sheet-image-input]").setInputFiles({ name: "rendering.png", mimeType: "image/png", buffer: testPng() });
  const img = page.locator("[data-image-id]");
  await expect(img).toHaveCount(1);
  await expect(page.locator("[data-testid=image-hud]")).toBeVisible();
  await expect(page.locator("[data-testid=image-dpi]")).toContainText("dpi");
  const w0 = Number(await page.locator("[data-testid=image-width]").inputValue());
  expect(w0).toBeGreaterThan(100);
  // Breite ändern: die Höhe folgt dem Seitenverhältnis (160 : 90); in die rechten zwei Spalten des Rasters schieben.
  await page.locator("[data-testid=image-width]").fill("250");
  await expect(page.locator("[data-image-id] svg image")).toHaveAttribute("height", "140.6");
  await page.locator("[data-testid=image-x]").fill("570");
  await page.locator("[data-testid=image-y]").fill("70");
  await expect(page.locator("[data-image-id] svg image")).toHaveAttribute("x", "570");
  // Zuschnitt links 25 %: Rahmen behält die Breite, die Höhe wächst (Ausschnitt schmaler); das ganze Bild liegt breiter dahinter.
  await page.locator("[data-testid=image-crop-left]").fill("25");
  await expect(page.locator("[data-image-id] svg image")).toHaveAttribute("width", /^333\./);
  // Verschieben per Maus: Körper ziehen, die Lage ändert sich.
  const body = page.locator("[data-image-body]");
  await expect(body).toBeAttached();
  const bb = (await body.boundingBox())!;
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width / 2 - 30, bb.y + bb.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Number(await page.locator("[data-testid=image-x]").inputValue())).toBeLessThan(570);
  await page.locator("[data-testid=image-x]").fill("570");
  await page.locator("[data-testid=image-y]").fill("70");

  // Anonyme Abgabe mit Kennwort; Plankopf zeigt nur das Kennwort.
  await page.locator("[data-testid=competition-anonymous]").check();
  await page.locator("[data-testid=competition-keyword]").fill("FALKE 7");
  await expect(page.locator("[data-poster-header] text", { hasText: "FALKE 7" })).toBeAttached();
  await expect(page.locator("[data-poster-header] text", { hasText: "Demo-Haus" })).toHaveCount(0);

  // Satz „WBW-Abgabe": ein PDF.
  await page.locator("[data-testid=publish-add-wbw]").click();
  await expect(page.locator("[data-publish-set]")).toHaveCount(1);
  const pending = page.waitForEvent("download");
  await page.locator("[data-publish-set] [data-publish-run]").click();
  const dl = await pending;
  expect(dl.suggestedFilename()).toBe("FALKE 7_WBW-Abgabe.pdf");
  const path = await dl.path();
  const bytes = await readFile(path);
  const text = bytes.toString("latin1");
  expect(text.slice(0, 5)).toBe("%PDF-");
  expect(text).toMatch(/\/MediaBox \[0 0 2383\.93\d* 1683\.7\d*/); // A1 quer
  expect(text).toContain("/Title (FALKE 7)");
  expect(text).not.toContain("jsPDF");
  expect(text).not.toContain("Demo-Haus");
  expect(text).toContain("/Subtype /Image");
  const content = pdfStreams(bytes);
  expect(content).toContain("(FALKE 7)");
  expect(content).toContain("(Kennwort)");
  expect(content).not.toContain("Demo-Haus");

  if (process.env.DOSSIER_SHOTS) {
    await mkdir(process.env.DOSSIER_SHOTS, { recursive: true });
    await writeFile(`${process.env.DOSSIER_SHOTS}/plakat-a1-quer.pdf`, bytes);
    await page.screenshot({ path: `${process.env.DOSSIER_SHOTS}/plakat-a1-quer-blatt.png` });
  }
});
