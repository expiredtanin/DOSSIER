// [170] Linux-App (Electron, AppImage): das gepackte Programm startet und kann den Kern-Ablauf — Neues Projekt, Wand per
// Befehlszeile, Speichern auf einen Pfad (atomar, Vorversion `.obp~`), Öffnen per Dialog und per Argument (`dossier datei.obp`),
// PDF-/DXF-Export auf die Platte, Autosave-Wiederherstellen nach `kill -9`.
//
// Läuft nur mit `DOSSIER_ELECTRON_BIN` (AppImage oder entpacktes `release/linux-unpacked/dossier`), sonst übersprungen —
// im normalen e2e-Lauf gibt es kein Paket. Bequem: `npm run test:linux-app` (baut nichts, sucht `release/*.AppImage`,
// startet unter `xvfb-run`, wenn kein Bildschirm da ist). Native Dialoge (GTK) lassen sich headless nicht bedienen: der
// Test ersetzt im Hauptprozess `dialog.showSaveDialog` und legt Downloads per `will-download` in einen Ordner — der Weg
// durch die App (IPC, atomares Schreiben, Export-Bytes) bleibt der echte.
import { _electron, type ElectronApplication, type Page } from "playwright";
import { test, expect } from "@playwright/test";
import { buildSync } from "esbuild";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = process.env.DOSSIER_ELECTRON_BIN ?? "";

test.skip(!BIN || !existsSync(BIN), "kein Electron-Paket (DOSSIER_ELECTRON_BIN), s. npm run test:linux-app");
test.describe.configure({ mode: "serial" });
// Start des Pakets + 30-s-Autosave-Takt: grosszügig.
test.setTimeout(180_000);

/**
 * Konsolenfehler, die nur headless (Xvfb, SwiftShader, kein echtes WebGPU) auftreten — gleiche Begründungen wie in
 * `e2e/app.ts`. Alles andere lässt den Test scheitern.
 */
const ALLOWED_CONSOLE_ERRORS = [/createBuffer failed|wgpu-.*webgpu\.rs/, /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/' failed/];

// Arbeitsordner erst anlegen, wenn die Tests laufen (übersprungen: nichts anlegen).
let work = "";
let config = ""; // XDG_CONFIG_HOME: eigenes Profil (userData, IndexedDB) je Lauf
let files = "";
let downloads = "";
let obp = "";
test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dossier-linux-app-"));
  config = join(work, "config");
  files = join(work, "files");
  downloads = join(work, "downloads");
  obp = join(files, "projekt.obp");
  mkdirSync(files, { recursive: true });
  mkdirSync(downloads, { recursive: true });
});

/** Laufende Instanzen: nach jedem Test beenden, auch wenn er scheitert (sonst hängt der Worker). */
const running = new Set<ElectronApplication>();
async function quit(app: ElectronApplication): Promise<void> {
  running.delete(app);
  // Schliess-Wächter ([116]) umgehen: das Fenster soll ohne Rückfrage zu.
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
test.afterEach(async () => {
  for (const app of [...running]) await quit(app);
});
test.afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** AppImage über FUSE einhängen geht nur mit /dev/fuse und libfuse2 (Ubuntu 24.04: Paket libfuse2t64); sonst entpacken. */
function canMountAppImage(): boolean {
  if (process.env.APPIMAGE_EXTRACT_AND_RUN === "1" || !existsSync("/dev/fuse")) return false;
  const dirs = ["/usr/lib/x86_64-linux-gnu", "/lib/x86_64-linux-gnu", "/usr/lib64", "/usr/lib"];
  return dirs.some((d) => existsSync(join(d, "libfuse.so.2")));
}

interface Running {
  app: ElectronApplication;
  page: Page;
  errors: string[];
}

async function launch(extraArgs: string[] = []): Promise<Running> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.NODE_OPTIONS; // gepackte Apps lehnen die meisten NODE_OPTIONS ab (Fehlermeldung im Log)
  delete env.ELECTRON_RUN_AS_NODE;
  env.XDG_CONFIG_HOME = config;
  if (BIN.endsWith(".AppImage") && !canMountAppImage()) env.APPIMAGE_EXTRACT_AND_RUN = "1";
  // --no-sandbox: Container laufen als root (Chromium verweigert dort die Sandbox); der Desktop-Eintrag setzt es ebenso.
  const app = await _electron.launch({ executablePath: BIN, args: ["--no-sandbox", ...extraArgs], env, timeout: 90_000 });
  running.add(app);
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !ALLOWED_CONSOLE_ERRORS.some((re) => re.test(m.text()))) errors.push(m.text().slice(0, 400));
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 400)}`));
  // Native Dialoge ersetzen: „Speichern unter" → fester Pfad; Downloads (Exporte) → Ordner `downloads`.
  await app.evaluate(
    ({ dialog, session }, { obp, downloads }) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: obp })) as typeof dialog.showSaveDialog;
      session.defaultSession.on("will-download", (_e, item) => item.setSavePath(`${downloads}/${item.getFilename()}`));
    },
    { obp, downloads },
  );
  return { app, page, errors };
}

async function close(r: Running): Promise<void> {
  expect(r.errors, "unerwartete Konsolenfehler").toEqual([]);
  await quit(r.app);
}

async function fileMenu(page: Page, item: string | RegExp): Promise<void> {
  await page.getByRole("button", { name: "Datei", exact: true }).click();
  await page.getByRole("option", { name: item }).click();
}

const elementRows = (page: Page) => page.locator(".nav-row");

async function drawWalls(page: Page, points: string[]): Promise<void> {
  const input = page.locator(".cmdline-input");
  await input.fill("wall");
  await input.press("Enter");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Startpunkt der Wand:");
  for (const p of points) {
    await input.fill(p);
    await input.press("Enter");
  }
  await input.press("Enter"); // leeres Enter übernimmt den Zug
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
}

const wallsIn = (file: string): number => (JSON.parse(readFileSync(file, "utf8")) as { walls: unknown[] }).walls.length;

test("Start: Fenster, Kern geladen, Version mit Buildnummer, Wand per Befehlszeile, Speichern atomar mit .obp~", async () => {
  const r = await launch();
  const { page } = r;
  await expect(page.getByRole("button", { name: /Neues Projekt/ }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveTitle(/Dossier/);
  // Startbildschirm zeigt Version und Buildnummer ([261]).
  await expect(page.getByText(/Build \d{6}\.\d+/).first()).toBeVisible();
  expect(page.url()).toMatch(/^dossier:\/\/app\//); // gepackt: eigenes Schema, nicht der Dev-Server
  // WebGPU ist freigegeben (electron-main.cjs: --enable-unsafe-webgpu); headless liefert SwiftShader den Adapter.
  expect(await page.evaluate(async () => !!(await (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter()))).toBe(true);
  // Paket trägt die Buildnummer ([261], scripts/electron-pack.cjs → package.json `dossierBuild`), gleich wie die Oberfläche.
  const packaged = await r.app.evaluate(({ app }) => ({
    version: app.getVersion(),
    build: (process.mainModule?.require("../package.json") as { dossierBuild?: string }).dossierBuild ?? "",
  }));
  expect(packaged.build).toMatch(/^\d{6}\.\d+$/);
  await expect(page.getByText(`${packaged.version} (Build ${packaged.build})`).first()).toBeVisible();

  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await page.getByRole("tab", { name: "Elemente", exact: true }).click();
  // Wände entstehen im Kern (Ops, Prüfung): zwei Wände = Kern-WASM läuft.
  await drawWalls(page, ["0,0", "6,0", "6,4"]);
  await expect(elementRows(page)).toHaveCount(2);

  // Erstes Speichern: „Speichern unter"-Dialog (ersetzt) → atomar geschrieben.
  await fileMenu(page, "Projekt speichern");
  await expect.poll(() => existsSync(obp)).toBe(true);
  expect(wallsIn(obp)).toBe(2);
  // Zweites Speichern auf den bekannten Pfad: ohne Dialog, Vorversion als `.obp~`, keine Temp-Datei übrig.
  await drawWalls(page, ["6,4", "0,4"]);
  await expect(elementRows(page)).toHaveCount(3);
  await fileMenu(page, "Projekt speichern");
  await expect.poll(() => (existsSync(obp) ? wallsIn(obp) : 0)).toBe(3);
  expect(existsSync(`${obp}~`)).toBe(true);
  expect(wallsIn(`${obp}~`)).toBe(2);
  expect(readdirSync(files).filter((f) => f.endsWith(".tmp"))).toEqual([]);

  // Exporte auf die Platte: Plan als PDF, DXF.
  await fileMenu(page, "Exportieren: PDF");
  const pdfDialog = page.getByRole("dialog", { name: "PDF/SVG exportieren" });
  await pdfDialog.getByRole("button", { name: "Als PDF", exact: true }).click();
  await expect.poll(() => (existsSync(downloads) ? readdirSync(downloads).filter((f) => f.endsWith(".pdf")) : []).length).toBe(1);
  const pdfName = readdirSync(downloads).find((f) => f.endsWith(".pdf"))!;
  await expect.poll(() => readFileSync(join(downloads, pdfName)).subarray(0, 5).toString("latin1")).toBe("%PDF-");

  await fileMenu(page, "Exportieren: DXF");
  await page.getByRole("dialog").locator(".imp-btn.primary").click();
  await expect.poll(() => readdirSync(downloads).filter((f) => f.endsWith(".dxf")).length).toBe(1);
  const dxfName = readdirSync(downloads).find((f) => f.endsWith(".dxf"))!;
  await expect.poll(() => readFileSync(join(downloads, dxfName), "utf8").trimEnd().endsWith("EOF")).toBe(true);
  expect(readFileSync(join(downloads, dxfName), "utf8")).toMatch(/ENTITIES/);
  await close(r);
});

test("Öffnen per Argument (dossier projekt.obp) und per Dialog, Speichern bleibt auf dem Pfad", async () => {
  const r = await launch([obp]);
  const { page } = r;
  // Per Argument geöffnet: kein Startbildschirm-Klick nötig, das Projekt ist da.
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("tab", { name: "Elemente", exact: true }).click();
  await expect(elementRows(page)).toHaveCount(3);

  // Neues Projekt, dann über „Projekt öffnen …" (Dateiauswahl) wieder die Datei: Pfad bleibt bekannt.
  await fileMenu(page, "Neues Projekt");
  const discard = page.getByRole("button", { name: "Nicht speichern" });
  if (await discard.isVisible({ timeout: 1500 }).catch(() => false)) await discard.click();
  await expect(elementRows(page)).toHaveCount(0);
  const chooser = page.waitForEvent("filechooser");
  await fileMenu(page, "Projekt öffnen …");
  await (await chooser).setFiles(obp);
  if (await discard.isVisible({ timeout: 1500 }).catch(() => false)) await discard.click();
  await expect(elementRows(page)).toHaveCount(3);
  await drawWalls(page, ["0,4", "0,0"]);
  await expect(elementRows(page)).toHaveCount(4);
  // Strg+S (Fokus aus der Befehlszeile nehmen, dort geht die Taste ins Textfeld): ohne Dialog auf den geöffneten Pfad.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+s");
  await expect.poll(() => wallsIn(obp)).toBe(4);
  expect(wallsIn(`${obp}~`)).toBe(3);
  await close(r);
});

test("Autosave: nach kill -9 bietet der nächste Start die ungesicherte Arbeit an", async () => {
  const r = await launch();
  const { page, app } = r;
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await page.getByRole("tab", { name: "Elemente", exact: true }).click();
  await drawWalls(page, ["10,10", "15,10", "15,13", "10,13"]);
  await expect(elementRows(page)).toHaveCount(3);
  // Autosave-Takt 30 s (state/autosave.ts): warten, bis die Kopie in IndexedDB liegt.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<string[]>((resolve) => {
              const open = indexedDB.open("dossier", 1);
              open.onerror = () => resolve([]);
              open.onsuccess = () => {
                const db = open.result;
                if (!db.objectStoreNames.contains("projects")) return resolve([]);
                const req = db.transaction("projects").objectStore("projects").getAllKeys();
                req.onsuccess = () => resolve(req.result as string[]);
                req.onerror = () => resolve([]);
              };
            }),
        ),
      { timeout: 60_000, intervals: [2000] },
    )
    .toContain("autosave:unsaved");
  expect(r.errors, "unerwartete Konsolenfehler").toEqual([]);
  // Harter Absturz: Hauptprozess mit SIGKILL (kein Schliess-Wächter, kein Aufräumen).
  const pid = await app.evaluate(() => process.pid);
  process.kill(pid, "SIGKILL");
  running.delete(app);
  await new Promise((res) => setTimeout(res, 2000));

  const again = await launch();
  const dialog = again.page.getByRole("dialog", { name: "Ungesicherte Arbeit gefunden" });
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await dialog.getByRole("button", { name: "Wiederherstellen" }).click();
  await again.page.getByRole("tab", { name: "Elemente", exact: true }).click();
  await expect(elementRows(again.page)).toHaveCount(3);
  await close(again);
});

// [268] Externe Adressen: `window.open` und Navigation erzeugen KEIN neues Fenster, https geht an `shell.openExternal`
// (hier im Hauptprozess abgefangen, sonst startete der Test einen Browser), fremde Navigation bleibt aus.
test("Externe Links: kein Kindfenster, shell.openExternal für https, Navigation bleibt in der App", async () => {
  const r = await launch();
  const { page, app } = r;
  await expect(page.getByRole("button", { name: /Neues Projekt/ }).first()).toBeVisible({ timeout: 60_000 });
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] };
    g.__opened = [];
    shell.openExternal = (async (url: string) => {
      g.__opened.push(url);
    }) as typeof shell.openExternal;
  });
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const opened = () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
  expect(await windows()).toBe(1);
  const appUrl = page.url();

  // Wie `openExternalUrl` (src/native/blender.ts) ausserhalb von Tauri.
  await page.evaluate(() => void window.open("https://example.org/a", "_blank", "noopener,noreferrer"));
  await expect.poll(opened).toEqual(["https://example.org/a"]);
  await page.evaluate(() => void window.open("file:///etc/passwd"));
  await page.evaluate(() => void window.open("http://example.org/unsicher"));
  await page.evaluate(() => void window.open("https://example.org/b")); // ohne noopener
  await expect.poll(opened).toEqual(["https://example.org/a", "https://example.org/b"]);
  expect(await windows()).toBe(1);

  // Navigation des App-Fensters auf fremde Adressen: gesperrt (https → System-Browser), Seite bleibt.
  await page.evaluate(() => {
    location.href = "https://example.org/nav";
  });
  await expect.poll(opened).toContain("https://example.org/nav");
  await page.evaluate(() => {
    location.href = "file:///etc/passwd";
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(appUrl);
  expect(await windows()).toBe(1);
  expect((await opened()).filter((u) => u.startsWith("file:") || u.startsWith("http:"))).toEqual([]);
  // Die App ist unverändert da (über den Hauptprozess geprüft: Playwright wartet nach einer abgebrochenen Navigation
  // auf deren Ende und würde den Locator-Aufruf hängen lassen).
  const state = await app.evaluate(async ({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    return { url: wc.getURL(), text: (await wc.executeJavaScript("document.body.innerText")) as string };
  });
  expect(state.url).toBe(appUrl);
  // Chromium meldet den Versuch auf file:// selbst als Konsolenfehler — erwartet, hier entfernen, den Rest prüft close().
  r.errors = r.errors.filter((e) => !/Not allowed to load local resource: file:\/\/\/etc\/passwd/.test(e));
  expect(state.text).toMatch(/Neues Projekt|New project/);
  await close(r);
});

// [215] Mitgeliefertes Cycles: im AppImage liegt `resources/cycles/cycles`; die Fassade `src/native/cyclesRuntime.ts` (hier mit esbuild in die
// Seite geladen, damit der echte Code über Preload → Hauptprozess → Prozessstart läuft) findet es, rendert die kleine Testszene mit 8 Samples
// zu einem PNG und meldet Fortschritt; Abbruch beendet den Prozess. Läuft nur, wenn das Paket mit Cycles gebaut wurde
// (`DOSSIER_CYCLES_DIR=<ordner> npm run electron:pack`, s. doc/CYCLES.md), sonst übersprungen.
test("Cycles: mitgeliefert, cyclesAvailable, runCycles rendert haus (8 Samples) zu PNG mit Fortschritt, Abbruch", async () => {
  const r = await launch();
  const { page, app } = r;
  await expect(page.getByRole("button", { name: /Neues Projekt/ }).first()).toBeVisible({ timeout: 60_000 });
  const res = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, resources: process.resourcesPath }));
  test.skip(!existsSync(join(res.resources, "cycles", "cycles")), "Paket ohne Cycles gebaut");
  expect(res.packaged).toBe(true);
  const facade = buildSync({
    entryPoints: [resolve(process.cwd(), "src/native/cyclesRuntime.ts")],
    bundle: true,
    format: "iife",
    globalName: "__cyclesFacade",
    footer: { js: "window.__cyclesFacade = __cyclesFacade;" },
    platform: "browser",
    write: false,
  }).outputFiles[0].text;
  await page.evaluate(facade); // Runtime.evaluate: von der Seiten-CSP (kein eval) nicht betroffen
  const xml = readFileSync(resolve(process.cwd(), "e2e/fixtures/cycles-haus.xml"), "utf8");
  type Facade = {
    cyclesAvailable(): Promise<boolean>;
    prepareCyclesScene(f: { path: string; bytes: Uint8Array }[]): Promise<string>;
    runCycles(dir: string, args: string[], on: (p: { fraction: number; sample: number; samples: number }) => void, signal?: AbortSignal): Promise<{ code: number; cancelled: boolean; lines: string[] }>;
    readCyclesFile(path: string): Promise<Uint8Array>;
  };
  const out = await page.evaluate(async (xml) => {
    const c = (window as unknown as { __cyclesFacade: Facade }).__cyclesFacade;
    const available = await c.cyclesAvailable();
    const dir = await c.prepareCyclesScene([{ path: "haus.xml", bytes: new TextEncoder().encode(xml) }]);
    const progress: { sample: number; samples: number }[] = [];
    const t0 = Date.now();
    const run = await c.runCycles(dir, ["--background", "--device", "CPU", "--samples", "8", "--width", "320", "--height", "180", "--output", "out.png", "haus.xml"], (p) => progress.push({ sample: p.sample, samples: p.samples }));
    const ms = Date.now() - t0;
    const png = await c.readCyclesFile(`${dir}/out.png`);
    // Abbruch: grosse Zahl Samples, nach dem ersten Fortschritt abbrechen
    const ac = new AbortController();
    const t1 = Date.now();
    const aborted = await c.runCycles(dir, ["--background", "--device", "CPU", "--samples", "5000", "--width", "640", "--height", "360", "--output", "x.png", "haus.xml"], () => ac.abort(), ac.signal);
    return { available, dir, progress, run, ms, head: Array.from(png.subarray(0, 8)), pngBytes: png.length, aborted, abortMs: Date.now() - t1 };
  }, xml);
  expect(out.available).toBe(true);
  expect(out.dir).toContain("dossier-render");
  expect(out.run.code).toBe(0);
  expect(out.run.cancelled).toBe(false);
  expect(out.progress.length).toBeGreaterThan(0);
  expect(out.progress.at(-1)).toEqual({ sample: 8, samples: 8 });
  expect(out.head).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(out.pngBytes).toBeGreaterThan(2000);
  expect(out.aborted.cancelled).toBe(true);
  expect(out.aborted.code).not.toBe(0);
  expect(out.abortMs).toBeLessThan(20_000);
  // Argumente werden im Hauptprozess geprüft: fremde Schalter und Pfade ausserhalb des Arbeitsordners starten nichts.
  const rejected = await page.evaluate(async (dir) => {
    const c = (window as unknown as { __cyclesFacade: Facade }).__cyclesFacade;
    const tries = [["--help", "haus.xml"], ["--output", "../../etc/x.png", "haus.xml"], ["/etc/hosts.xml"]];
    const outcomes: string[] = [];
    for (const a of tries) outcomes.push(await c.runCycles(dir, a, () => {}).then(() => "gestartet", (e: Error) => e.message));
    return outcomes;
  }, out.dir);
  expect(rejected.every((m) => m !== "gestartet")).toBe(true);
  // Das gerenderte Bild stimmt grob (kein leeres Schwarz): Dateigrösse des 320×180-PNG nach Entrauschen > 2 kB (oben).
  r.errors = r.errors.filter((e) => !/Error invoking remote method 'cycles:start'/.test(e));
  await close(r);
});
