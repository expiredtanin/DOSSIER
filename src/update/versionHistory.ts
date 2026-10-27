// Versionsverlauf fuer den manuellen Rollback (Settings → Update): Tauris
// Updater-Plugin kennt nur „neuere Version installieren", kein Downgrade-
// Manifest mit Auswahl. Statt das Plugin zu verbiegen, pflegen wir einen
// eigenen, schlanken Index `versions.json` (liegt auf demselben Gitea-
// Release „latest" wie `latest.json`, s. checkForUpdate.ts) und bieten pro
// Eintrag nur den DMG-Download im System-Browser an — Installation bleibt
// der gewohnte manuelle Schritt (DMG oeffnen, App in Applications ersetzen).
import { isTauriRuntime } from "../native/projectFile";

export interface VersionEntry {
  version: string;
  /** Git-Tag des Releases, z. B. "v0.1.0". */
  tag: string;
  /** ISO-Datum. */
  pub_date: string;
  notes: string;
  /** Dateiname der DMG innerhalb dieses Release-Tags. */
  dmg: string;
}

const VERSIONS_URL =
  "https://git.openbureau.ch/karim/DOSSIER-STANDALONE/releases/download/latest/versions.json";

/** Leeres Array ausserhalb von Tauri oder bei Netzwerk-/Parsefehlern (keine
 * Wurf-Semantik hier — der Aufrufer zeigt einfach eine leere Liste). */
export async function fetchVersionHistory(): Promise<VersionEntry[]> {
  if (!isTauriRuntime()) return [];
  try {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const res = await tauriFetch(VERSIONS_URL);
    if (!res.ok) return [];
    const data = (await res.json()) as VersionEntry[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function downloadUrlFor(entry: VersionEntry): string {
  return `https://git.openbureau.ch/karim/DOSSIER-STANDALONE/releases/download/${entry.tag}/${entry.dmg}`;
}

/** Oeffnet den DMG-Download im System-Standardbrowser (kein In-App-Download —
 * Installation bleibt manuell). */
export async function openVersionDownload(entry: VersionEntry): Promise<void> {
  const { open } = await import("@tauri-apps/plugin-shell");
  await open(downloadUrlFor(entry));
}
