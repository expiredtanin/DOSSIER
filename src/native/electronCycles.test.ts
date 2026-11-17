// [215] Cycles im Electron-Hauptprozess (scripts/electron-cycles.cjs): Argumentprüfung, Pfadwahl, Prozessstart mit Ersatzprogramm.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

type Job = { jobId: string; line?: string; code?: number };
const cy = createRequire(import.meta.url)("../../scripts/electron-cycles.cjs") as {
  register: (ipc: unknown, app: { isPackaged: boolean }) => void;
  cyclesDir: (o: { isPackaged: boolean; resourcesPath: string; env?: Record<string, string>; repoRoot?: string }) => string;
  cyclesExe: (dir: string, o?: { platform?: string; arch?: string }) => string | null;
  validateCyclesArgs: (dir: string, args: unknown) => string[];
};

const root = join(tmpdir(), "dossier-render");
const dirs: string[] = [];
const scene = () => {
  mkdirSync(root, { recursive: true });
  const d = mkdtempSync(join(root, "t-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("validateCyclesArgs", () => {
  it("erlaubte Schalter, Pfade werden im Arbeitsordner aufgelöst", () => {
    const d = scene();
    expect(cy.validateCyclesArgs(d, ["--background", "--samples", "8", "--width", "320", "--height", "180", "--device", "CPU", "--output", "out.png", "haus.xml"])).toEqual([
      "--background", "--samples", "8", "--width", "320", "--height", "180", "--device", "CPU", "--output", join(d, "out.png"), join(d, "haus.xml"),
    ]);
    expect(cy.validateCyclesArgs(d, ["--device", "METAL+CPU", "sub/a.xml"])).toContain(join(d, "sub", "a.xml"));
  });
  it("lehnt Fremdes ab: Schalter, Werte, Pfade ausserhalb, falscher Arbeitsordner, Shell-Zeichen", () => {
    const d = scene();
    const bad = (args: unknown) => expect(() => cy.validateCyclesArgs(d, args)).toThrow();
    bad(["--help", "a.xml"]);
    bad(["--samples", "0", "a.xml"]);
    bad(["--samples", "8; rm -rf /", "a.xml"]);
    bad(["--samples", "99999999", "a.xml"]);
    bad(["--device", "CPU;ls", "a.xml"]);
    bad(["--output", "../out.png", "a.xml"]);
    bad(["--output", "/etc/passwd", "a.xml"]);
    bad(["--output", "out.sh", "a.xml"]);
    bad(["../../etc/x.xml"]);
    bad(["/etc/hosts.xml"]);
    bad(["a.xml", "b.xml"]); // zwei Szenen
    bad(["--samples", "8"]); // keine Szene
    bad(["--samples"]); // Wert fehlt
    bad("a.xml");
    expect(() => cy.validateCyclesArgs(tmpdir(), ["a.xml"])).toThrow(/dossier-render/);
    expect(() => cy.validateCyclesArgs(join(root, ".."), ["a.xml"])).toThrow();
  });
});

describe("cyclesDir / cyclesExe", () => {
  it("gepackt: resources/cycles, keine Umlenkung per Umgebung", () => {
    expect(cy.cyclesDir({ isPackaged: true, resourcesPath: "/opt/dossier/resources", env: { DOSSIER_CYCLES_DIR: "/boese" } })).toBe("/opt/dossier/resources/cycles");
  });
  it("ungepackt: DOSSIER_CYCLES_DIR, sonst build/cycles", () => {
    expect(cy.cyclesDir({ isPackaged: false, resourcesPath: "/x", env: { DOSSIER_CYCLES_DIR: "/lokal/c" } })).toBe("/lokal/c");
    expect(cy.cyclesDir({ isPackaged: false, resourcesPath: "/x", env: {}, repoRoot: "/repo" })).toBe("/repo/build/cycles");
  });
  it("Programm muss ausführbar sein; Intel-Mac: nicht verfügbar", () => {
    const d = scene();
    expect(cy.cyclesExe(d)).toBeNull();
    writeFileSync(join(d, "cycles"), "#!/bin/sh\n");
    chmodSync(join(d, "cycles"), 0o644);
    expect(cy.cyclesExe(d)).toBeNull();
    chmodSync(join(d, "cycles"), 0o755);
    expect(cy.cyclesExe(d)).toBe(join(d, "cycles"));
    expect(cy.cyclesExe(d, { platform: "darwin", arch: "x64" })).toBeNull();
    expect(cy.cyclesExe(d, { platform: "darwin", arch: "arm64" })).toBe(join(d, "cycles"));
  });
});

describe("Prozessstart (Ersatzprogramm)", () => {
  it("meldet Zeilen (\\r-getrennt), Ende, nutzt den Arbeitsordner und CYCLES_KERNEL_PATH; Abbruch beendet", async () => {
    if (process.platform === "win32") return;
    const pkg = scene();
    mkdirSync(join(pkg, "source"));
    writeFileSync(
      join(pkg, "cycles"),
      '#!/bin/sh\nprintf "Updating\\rProgress 50.00   Sample 1/2\\rProgress 100.00   Sample 2/2\\n"\necho "cwd=$(pwd) kernel=$CYCLES_KERNEL_PATH args=$*"\n[ "$1" = "--quiet" ] && exec sleep 30\nexit 3\n',
    );
    chmodSync(join(pkg, "cycles"), 0o755);
    process.env.DOSSIER_CYCLES_DIR = pkg;
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const listeners = new Map<string, (...a: unknown[]) => unknown>();
    cy.register({ handle: (c: string, f: (...a: unknown[]) => unknown) => handlers.set(c, f), on: (c: string, f: (...a: unknown[]) => unknown) => listeners.set(c, f) }, { isPackaged: false });
    expect(await handlers.get("cycles:where")!()).toBe(join(pkg, "cycles"));

    const work = scene();
    const sent: { ch: string; p: Job }[] = [];
    const ev = { sender: { isDestroyed: () => false, send: (ch: string, p: Job) => sent.push({ ch, p }) } };
    const done = () => new Promise<void>((res) => { const t = setInterval(() => sent.some((s) => s.ch === "cycles:exit") && (clearInterval(t), res()), 20); });
    await handlers.get("cycles:start")!(ev, "j1", work, ["--background", "haus.xml"]);
    await done();
    const lines = sent.filter((s) => s.ch === "cycles:line").map((s) => s.p.line);
    expect(lines.slice(0, 3)).toEqual(["Updating", "Progress 50.00   Sample 1/2", "Progress 100.00   Sample 2/2"]);
    expect(lines[3]).toContain(`kernel=${join(pkg, "source")}`);
    expect(lines[3]).toContain(`args=--background ${join(work, "haus.xml")}`);
    expect(sent.find((s) => s.ch === "cycles:exit")!.p.code).toBe(3);

    // Abbruch: das Ersatzprogramm schläft bei --quiet
    sent.length = 0;
    await handlers.get("cycles:start")!(ev, "j2", work, ["--quiet", "haus.xml"]);
    await new Promise((r) => setTimeout(r, 150));
    listeners.get("cycles:cancel")!({}, "j2");
    await done();
    expect(sent.find((s) => s.ch === "cycles:exit")!.p.code).toBe(-1);

    // fremde Argumente: kein Prozess
    expect(() => handlers.get("cycles:start")!(ev, "j3", work, ["--help", "haus.xml"])).toThrow(/nicht erlaubt/);
    delete process.env.DOSSIER_CYCLES_DIR;
  });
});
