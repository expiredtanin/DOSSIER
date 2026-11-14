// Fester Check vor jedem Abschluss (lessons-bimcraft [22]): TypeScript, Vitest und die
// Rust-Tests aller eigenständigen Crates. Bricht beim ersten Fehler ab.
//   npm run check            alles
//   npm run check -- --fast  nur tsc + vitest
// Die IFC-Prüfungen in vitest (exportIfc.*.test.ts) laufen nur mit `pip install ifcopenshell numpy pytest` (sonst übersprungen).
// `cargo fmt`/`clippy` sind noch nicht Teil des Checks: die Crates sind nie formatiert
// worden (ein Reformat wäre ein Riesen-Diff) — eigener Schritt, s. docs/lessons-bimcraft.md.
import { spawnSync } from "node:child_process";

const fast = process.argv.includes("--fast");
const crates = ["core", "render2d", "render3d", "kernel2d", "trucksolid", "fileio", "hatchgen"];
const steps = [
  { name: "tsc", cmd: "npx", args: ["tsc", "--noEmit", "-p", "."] },
  { name: "vitest", cmd: "npx", args: ["vitest", "run"] },
  ...(fast ? [] : crates.map((c) => ({ name: `cargo test ${c}`, cmd: "cargo", args: ["test", "--quiet"], cwd: `src-tauri/${c}` }))),
  // [258] Robustheit der WASM-Bindungen: Feature `web` ist nicht Standard, `cargo test` allein überspringt den Test.
  ...(fast ? [] : [{ name: "cargo test core robustness_web (web)", cmd: "cargo", args: ["test", "--quiet", "--features", "web", "--test", "robustness_web"], cwd: "src-tauri/core",
      // Release-Verhalten (WASM wrappt bei Überlauf): Debug-Überlaufprüfung würde Panics melden, die dort nicht vorkommen; spart zudem den Release-Build.
      env: { CARGO_PROFILE_DEV_OVERFLOW_CHECKS: "false" } }]),
];

const t0 = Date.now();
for (const s of steps) {
  const t = Date.now();
  process.stdout.write(`▶ ${s.name} … `);
  const r = spawnSync(s.cmd, s.args, { cwd: s.cwd, encoding: "utf8", env: { ...process.env, ...s.env } });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.log(`FEHLER (${secs}s)\n`);
    console.log((r.stdout ?? "").split("\n").slice(-40).join("\n"));
    console.log(r.stderr ?? "");
    process.exit(1);
  }
  console.log(`ok (${secs}s)`);
}
console.log(`\nAlles grün (${((Date.now() - t0) / 1000).toFixed(0)}s).`);
