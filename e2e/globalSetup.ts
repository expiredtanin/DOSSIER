// Erzeugt die .obp-Fixture (Beispielprojekt) mit der CLI — `*.obp` ist gitignoriert, also nie im Repo.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { BEISPIEL_OBP } from "./paths";

/**
 * Anzeige-Pakete prüfen: ein ohne `--features web` gebautes wasm-pack-Paket lädt still und exportiert nichts —
 * dann fallen 3D-Ansicht, Begehen und Pathtracer ohne klaren Hinweis aus. Lieber gleich mit Bauanleitung abbrechen.
 */
function assertWebPackages(): void {
  const pkgs: [string, string, string][] = [
    ["src/engine/pkg3d/render3d.d.ts", "class WebModelRenderer", "build:engine3d"],
    ["src/engine/pkg/render2d.d.ts", "class WebPlanRenderer", "build:engine"],
  ];
  for (const [file, marker, script] of pkgs) {
    if (!existsSync(file) || !readFileSync(file, "utf8").includes(marker)) {
      throw new Error(`${file} fehlt oder ohne Feature „web“ gebaut (kein ${marker}): npm run ${script}`);
    }
  }
}

export default function globalSetup(): void {
  assertWebPackages();
  if (!existsSync("dist-cli/dossier-cli.mjs")) {
    execFileSync("npm", ["run", "build:cli"], { stdio: "inherit" });
  }
  mkdirSync(dirname(BEISPIEL_OBP), { recursive: true });
  execFileSync("node", ["dist-cli/dossier-cli.mjs", ":beispiel", "migrate", "--out", BEISPIEL_OBP], {
    stdio: "inherit",
  });
}
