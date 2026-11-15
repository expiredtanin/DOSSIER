// [261] Version und Buildnummer der laufenden Oberfläche. Werte setzt Vite (`define`, vite.config.ts), der CLI-Build
// (scripts/build-cli.mjs) und Vitest (vitest.config.ts) aus package.json + scripts/build-number.cjs; fehlt `define`, steht „dev“.

declare const __DOSSIER_VERSION__: string;
declare const __DOSSIER_BUILD__: string;

export interface BuildInfo {
  /** Anwender-Version (semver, z. B. 1.0.0-beta.1). */
  version: string;
  /** Interne Buildnummer JJMMTT.N. */
  build: string;
}

export const BUILD_INFO: BuildInfo = {
  version: typeof __DOSSIER_VERSION__ !== "undefined" ? __DOSSIER_VERSION__ : "0.0.0-dev",
  build: typeof __DOSSIER_BUILD__ !== "undefined" ? __DOSSIER_BUILD__ : "dev",
};

/** „1.0.0-beta.1 (Build 261115.1)“; `buildWord` kommt aus t("about.build"). */
export function formatBuildInfo(info: BuildInfo, buildWord: string): string {
  return `${info.version} (${buildWord} ${info.build})`;
}

/** „Build 261115.1“ für die Statusleiste. */
export function formatBuildShort(info: BuildInfo, buildWord: string): string {
  return `${buildWord} ${info.build}`;
}
