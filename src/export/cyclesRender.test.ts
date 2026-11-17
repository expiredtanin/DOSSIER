// [215] Cycles: Szene aus dem Kern, Zeilen des Programms, EXR lesen, PNG schreiben, Ablauf mit Ersatz-Host. Ein echter
// Lauf steht in `cyclesRender.integration.test.ts` (nur mit `DOSSIER_CYCLES`).
import { describe, expect, it } from "vitest";
import { deflateSync, inflateSync } from "node:zlib";
import { sampleProject } from "../model/sampleProject";
import { makeExr } from "./cyclesExr.testutil";
import {
  buildCyclesPackage,
  cyclesArgs,
  cyclesSceneInfo,
  encodePng,
  exrToPng,
  parseCyclesLine,
  readExr,
  runCyclesRender,
  CyclesMissingError,
  type CyclesHost,
} from "./cyclesRender";

const codec = {
  inflate: (d: Uint8Array) => new Uint8Array(inflateSync(d)),
  deflate: (d: Uint8Array) => new Uint8Array(deflateSync(d)),
};

describe("parseCyclesLine", () => {
  it("Fortschritt, Phasen, Fehler", () => {
    expect(parseCyclesLine("Progress 06.25   Sample 1/16")).toEqual({ kind: "sample", done: 1, total: 16 });
    expect(parseCyclesLine("Progress 00.00   Loading render kernels (may take a few minutes the first time)")).toEqual({ kind: "stage", stage: "kernels" });
    expect(parseCyclesLine("Writing image /tmp/x/render.exr")).toEqual({ kind: "stage", stage: "write" });
    expect(parseCyclesLine("Finished Rendering.")).toEqual({ kind: "done" });
    expect(parseCyclesLine("00:00.00 | ERROR: Unknown input socket name \"vector\" on \"alb\"")).toEqual({ kind: "error", message: "Unknown input socket name \"vector\" on \"alb\"" });
    expect(parseCyclesLine("Progress 00.00   Updating Meshes")).toEqual({ kind: "stage", stage: "scene" });
    expect(parseCyclesLine("irgendwas")).toBeNull();
  });

  it("Kommandozeile", () => {
    expect(cyclesArgs({ width: 640, height: 360, samples: 8 }, "/t/scene.xml", "/t/render.exr", { device: "CPU", threads: 2 })).toEqual([
      "--background", "--samples", "8", "--width", "640", "--height", "360", "--output", "/t/render.exr", "--device", "CPU", "--threads", "2", "/t/scene.xml",
    ]);
  });
});

describe("EXR und PNG", () => {
  const rgb = new Float32Array(20 * 18 * 3).map((_, i) => (i % 7) * 0.5 + (i % 3) * 0.125);

  it.each([false, true])("EXR lesen (ZIP: %s) gibt die Pixel zurück", (zip) => {
    const img = readExr(makeExr(20, 18, rgb, zip), codec.inflate);
    expect([img.width, img.height]).toEqual([20, 18]);
    expect(Array.from(img.rgb)).toEqual(Array.from(rgb));
  });

  it("EXR mit anderer Kompression/Unsinn wirft statt zu raten", () => {
    expect(() => readExr(new Uint8Array(40), codec.inflate)).toThrow("Kein OpenEXR");
    const exr = makeExr(4, 4, new Float32Array(48), false);
    // Kompression PIZ (4) eintragen: Position des Wertes hinter dem Attribut `compression`.
    const at = new TextDecoder("latin1").decode(exr).indexOf("compression\0compression\0") + "compression\0compression\0".length + 4;
    exr[at] = 4;
    expect(() => readExr(exr, codec.inflate)).toThrow("Kompression 4");
  });

  it("PNG: Kopf, Prüfsummen, Rückweg über zlib", () => {
    const px = new Uint8Array(5 * 3 * 3).map((_, i) => (i * 7) & 255);
    const png = encodePng(5, 3, px, codec.deflate);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer, png.byteOffset);
    expect([dv.getUint32(16), dv.getUint32(20), png[24], png[25]]).toEqual([5, 3, 8, 2]);
    // IDAT entpacken: je Zeile Filter 0 + RGB.
    const len = dv.getUint32(33);
    expect(new TextDecoder().decode(png.subarray(37, 41))).toBe("IDAT");
    const raw = inflateSync(png.subarray(41, 41 + len));
    expect(raw.length).toBe((5 * 3 + 1) * 3);
    expect(raw[0]).toBe(0);
    expect(Array.from(raw.subarray(1, 16))).toEqual(Array.from(px.subarray(0, 15)));
    // CRC des IDAT-Chunks prüfen (Standardverfahren, zlib.crc32 ab Node 22 nicht nötig: eigene Tabelle).
    let c = 0xffffffff;
    for (const b of png.subarray(37, 41 + len)) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    expect((c ^ 0xffffffff) >>> 0).toBe(dv.getUint32(41 + len));
  });

  it("Tonwert im Kern: Szenenwerte → sichtbares Bild (Weiss besonnt unter 255, Schwarz 0)", () => {
    const img = { width: 2, height: 1, rgb: new Float32Array([0, 0, 0, 1.2, 1.2, 1.2]) };
    const png = exrToPng(img, "filmic", 0, codec.deflate);
    const raw = inflateSync(png.subarray(41, 41 + new DataView(png.buffer, png.byteOffset).getUint32(33)));
    expect(Array.from(raw.subarray(1, 4))).toEqual([0, 0, 0]);
    expect(raw[4]).toBeGreaterThan(215);
  });
});

describe("Szene aus dem Kern", () => {
  it("Beispielprojekt: XML mit Netzen, Glas, Kamera, Sonne; Optionen kommen an", () => {
    const info = cyclesSceneInfo(sampleProject, { width: 640, height: 360, samples: 8, camera: { preset: "iso" }, whenMs: Date.UTC(2026, 5, 21, 12, 0, 0) });
    expect(info.meshes).toBeGreaterThan(5);
    expect([info.width, info.height, info.samples]).toEqual([640, 360, 8]);
    expect(info.xml).toContain("<cycles>");
    expect(info.xml).toContain("camera_type=\"orthograph\"");
    expect(info.sunElevation).toBeGreaterThan(60);
  });

  it("Bildkarten: geladene kommen als Dateien neben die XML, fehlende fallen auf Einfarbig zurück", async () => {
    const p = { ...sampleProject, components: sampleProject.components.map((c) => ({ ...c, material: { color: "/assets/materials/Bricks104/color.jpg", sizeM: 2 } })) };
    const base = { width: 320, height: 180, samples: 4 };
    const ok = await buildCyclesPackage(p, base, async () => new Uint8Array([1, 2, 3]));
    expect(ok.files.map((f) => f.path)).toContain("scene.xml");
    expect(ok.files.some((f) => f.path.startsWith("textures/0_color."))).toBe(true);
    expect(ok.info.xml).toContain("image_texture");
    const none = await buildCyclesPackage(p, base, async () => null);
    expect(none.files.map((f) => f.path)).toEqual(["scene.xml"]);
    expect(none.missingTextures.length).toBeGreaterThan(0);
    expect(none.info.xml).not.toContain("filename=");
    // Ohne Lader (Browser ohne Bilder): nie eine Datei erwähnen, die fehlt.
    const noLoader = await buildCyclesPackage(p, base);
    expect(noLoader.info.xml).not.toContain("filename=");
  });
});

describe("runCyclesRender", () => {
  /** Ersatz-Gastgeber: schreibt ein EXR, meldet Zeilen wie Cycles. */
  function fakeHost(exr: Uint8Array | null, code = 0, lines: string[] = ["Progress 50.00   Sample 4/8", "Progress 100.00   Sample 8/8", "Finished Rendering."]) {
    const written = new Map<string, Uint8Array>();
    const calls: string[][] = [];
    const host: CyclesHost = {
      find: async (custom) => (custom === "fehlt" ? null : "/fake/cycles"),
      prepare: async (files) => {
        for (const f of files) written.set(f.path, f.bytes);
        return "/work";
      },
      spawn: (_exe, args, onLine) => {
        calls.push(args);
        for (const l of lines) onLine(l);
        if (exr) written.set("render.exr", exr);
        return { done: Promise.resolve(code), cancel: () => {} };
      },
      readFile: async (path) => {
        const b = written.get(path.replace("/work/", ""));
        if (!b) throw new Error("fehlt");
        return b;
      },
      join: (d, r) => `${d}/${r}`,
    };
    return { host, calls, written };
  }

  it("Ablauf: Paket auspacken, Programm starten, Fortschritt melden, PNG liefern", async () => {
    const pkg = await buildCyclesPackage(sampleProject, { width: 4, height: 2, samples: 8 });
    const exr = makeExr(4, 2, new Float32Array(24).fill(0.3), true);
    const { host, calls, written } = fakeHost(exr);
    const seen: number[] = [];
    const res = await runCyclesRender(host, pkg, { codec, device: "CPU", onProgress: (e) => seen.push(e.fraction) });
    expect(written.has("scene.xml")).toBe(true);
    expect(calls[0]).toContain("--device");
    expect(calls[0].slice(-1)[0]).toBe("/work/scene.xml");
    expect(seen).toContain(0.5);
    expect(seen.at(-1)).toBe(1);
    expect([res.width, res.height]).toEqual([4, 2]);
    expect(Array.from(res.png.subarray(1, 4))).toEqual([80, 78, 71]);
  });

  it("Fehler: Programm fehlt, Exit-Code ≠ 0, kein Bild", async () => {
    const pkg = await buildCyclesPackage(sampleProject, { width: 4, height: 2, samples: 8 });
    await expect(runCyclesRender(fakeHost(null).host, pkg, { codec, cyclesPath: "fehlt" })).rejects.toBeInstanceOf(CyclesMissingError);
    await expect(runCyclesRender(fakeHost(null, 3, ["00:00.00 | ERROR: kaputt"]).host, pkg, { codec })).rejects.toThrow(/Code 3.*kaputt/);
    await expect(runCyclesRender(fakeHost(null).host, pkg, { codec })).rejects.toThrow("kein Bild");
  });
});
