// Erzeugt die .obp-Fixture (Beispielprojekt) mit der CLI — `*.obp` ist gitignoriert, also nie im Repo.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BEISPIEL_OBP } from "./paths";

export default function globalSetup(): void {
  if (!existsSync("dist-cli/dossier-cli.mjs")) {
    execFileSync("npm", ["run", "build:cli"], { stdio: "inherit" });
  }
  mkdirSync(dirname(BEISPIEL_OBP), { recursive: true });
  execFileSync("node", ["dist-cli/dossier-cli.mjs", ":beispiel", "migrate", "--out", BEISPIEL_OBP], {
    stdio: "inherit",
  });
}
