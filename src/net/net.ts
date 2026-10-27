// Einziges Tor ins Netz (lessons-bimcraft [47]). Jeder entfernte Abruf läuft über `netFetch`:
//  • Offline-Modus (Einstellungen → Allgemein): entfernte URLs werden abgelehnt.
//  • Nur bekannte Hosts (ambientCG, swisstopo, Overpass, lokaler Proxy) — alles andere wird
//    abgelehnt, damit nirgends unbemerkt neue Verbindungen entstehen.
//  • Lokale Quellen (data:, blob:, relative Pfade) laufen unverändert durch.
// Ein Test (`net.test.ts`) verbietet `fetch(` ausserhalb dieses Moduls. Das Update-Plugin von
// Tauri (`update/checkForUpdate.ts`) ist die zweite, bewusst getrennte Netz-Stelle.

const OFFLINE_KEY = "dossier.offline";

/** Hosts, zu denen Dossier Verbindung aufnehmen darf. */
export const ALLOWED_HOSTS: readonly string[] = [
  "ambientcg.com",
  "api.ambientcg.com",
  "geo.admin.ch",
  "api3.geo.admin.ch",
  "wms.geo.admin.ch",
  "data.geo.admin.ch",
  "overpass-api.de",
  "nominatim.openstreetmap.org",
  "localhost",
  "127.0.0.1",
];

export class OfflineError extends Error {
  constructor(url: string) {
    super(`Offline-Modus: Zugriff auf ${url} blockiert.`);
    this.name = "OfflineError";
  }
}
export class HostNotAllowedError extends Error {
  constructor(url: string) {
    super(`Host nicht erlaubt: ${url}`);
    this.name = "HostNotAllowedError";
  }
}

const extraHosts = new Set<string>();
/** Erlaubt zusätzlich einen vom Nutzer konfigurierten Host (z. B. den Geo-Proxy). */
export function allowHost(urlOrHost: string): void {
  try {
    extraHosts.add(urlOrHost.includes("/") ? new URL(urlOrHost).hostname.toLowerCase() : urlOrHost.toLowerCase());
  } catch {
    /* ungültige URL ignorieren */
  }
}

let offlineOverride: boolean | null = null;

export function isOffline(): boolean {
  if (offlineOverride !== null) return offlineOverride;
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(OFFLINE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setOffline(value: boolean): void {
  offlineOverride = value;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(OFFLINE_KEY, value ? "1" : "0");
  } catch {
    /* Speicher gesperrt: nur der Laufzeitwert gilt */
  }
}

/** Nur für Tests: Override zurücksetzen. */
export function resetOfflineForTests(): void {
  offlineOverride = null;
}

/** Ist `url` eine lokale Quelle (kein Netzzugriff)? */
export function isLocalUrl(url: string): boolean {
  return /^(data:|blob:)/i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url) || /^(tauri|asset|ipc):/i.test(url) || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);
}

function hostAllowed(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return extraHosts.has(h) || ALLOWED_HOSTS.some((a) => h === a || h.endsWith("." + a));
  } catch {
    return false;
  }
}

/** `fetch` mit Offline-Schalter und Host-Liste. */
export async function netFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!isLocalUrl(url)) {
    if (isOffline()) throw new OfflineError(url);
    if (!hostAllowed(url)) throw new HostNotAllowedError(url);
  }
  return fetch(url, init);
}
