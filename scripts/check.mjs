// Fester Check vor jedem Abschluss (lessons-bimcraft [22]): TypeScript, Vitest und die
// Rust-Tests aller eigenständigen Crates. Bricht beim ersten Fehler ab.
//   npm run check            alles
//   npm run check -- --fast  nur tsc + vitest
// `cargo fmt`/`clippy` sind noch nicht Teil des Checks: die Crates sind nie formatiert
// worden (ein Reformat wäre ein Riesen-Diff) — eigener Schritt, s. docs/lessons-bimcraft.md.
import { spawnSync } from "node:child_process";

const fast = process.argv.includes("--fast");
const crates = ["core", "render2d", "render3d", "kernel2d", "trucksolid", "fileio"];
const steps = [
  { name: "tsc", cmd: "npx", args: ["tsc", "--noEmit", "-p", "."] },
  { name: "vitest", cmd: "npx", args: ["vitest", "run"] },
  ...(fast ? [] : crates.map((c) => ({ name: `cargo test ${c}`, cmd: "cargo", args: ["test", "--quiet"], cwd: `src-tauri/${c}` }))),
];

const t0 = Date.now();
for (const s of steps) {
  const t = Date.now();
  process.stdout.write(`▶ ${s.name} … `);
  const r = spawnSync(s.cmd, s.args, { cwd: s.cwd, encoding: "utf8" });
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
