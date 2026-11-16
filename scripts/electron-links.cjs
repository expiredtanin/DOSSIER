// [268] Externe Adressen und fremde Navigation im Electron-Hauptprozess — reine Entscheide (getestet in
// src/native/electronLinks.test.ts), `electron-main.cjs` verdrahtet sie. Grund: ohne Handler öffnete `window.open`
// (Hilfe → Fehler melden, „Blender laden“ über `openExternalUrl`) ein Electron-Kindfenster mit Preload und App-CSP.

/** Adressen, die der System-Browser/-Mailer öffnen darf: nur https und mailto. */
function isExternalOpenable(url) {
  try {
    const p = new URL(String(url)).protocol;
    return p === "https:" || p === "mailto:";
  } catch {
    return false;
  }
}

/** Ursprung einer Adresse, oder null (ungültig/opak). */
function originOf(url) {
  try {
    const u = new URL(String(url));
    if (u.origin !== "null") return u.origin;
    // Eigene Schemas (`dossier://app`): Node meldet „null“, Chromium den Ursprung — hier gleich aus Schema + Host.
    return u.protocol === "dossier:" && u.host ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

/**
 * Entscheid für `window.open`/`target=_blank`: nie ein Kindfenster. `{ action: "deny", external }`; `external` ist die Adresse,
 * die stattdessen im System-Browser aufgeht (sonst null).
 */
function windowOpenDecision(url) {
  return { action: "deny", external: isExternalOpenable(url) ? String(url) : null };
}

/**
 * Entscheid für Navigation/Weiterleitung des App-Fensters: erlaubt nur innerhalb des App-Ursprungs
 * (`dossier://app` bzw. der Dev-Server). Sonst `{ allow: false, external }` (https/mailto → System-Browser).
 */
function navigationDecision(url, appOrigins) {
  const o = originOf(url);
  if (o && appOrigins.includes(o)) return { allow: true, external: null };
  return { allow: false, external: isExternalOpenable(url) ? String(url) : null };
}

/** CSP nur für Antworten des App-Ursprungs (fremde Seiten, falls je geladen, bekommen sie nicht). */
function shouldSetCsp(url, appOrigins) {
  const o = originOf(url);
  return !!o && appOrigins.includes(o);
}

module.exports = { isExternalOpenable, windowOpenDecision, navigationDecision, shouldSetCsp };
