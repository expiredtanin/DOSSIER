---
title: "Mitarbeiten"
linkTitle: "Mitarbeiten"
weight: 5
---

Beiträge sind willkommen: Fehlerberichte, Tests mit echten Projekten,
Übersetzungen, Code. Der Quellcode liegt auf
[GitHub](https://github.com/expiredtanin/DOSSIER); Fragen und Fehler als
[Issue](https://github.com/expiredtanin/DOSSIER/issues), Änderungen als Pull
Request gegen `master`.

## Arbeitsablauf

Die verbindliche Fassung steht in
[`CLAUDE.md`](https://github.com/expiredtanin/DOSSIER/blob/master/CLAUDE.md)
(sie gilt für Menschen wie für KI-Agenten). Kurz:

1. **Lesen:** `TODO.md` – die Arbeitsliste mit stabilen Nummern wie `[63]`
   und Stand ✅ ◐ ○ – und `CLAUDE.md`.
2. **Test zuerst**, dann Code. Rust: `cargo test` im Crate; TypeScript:
   Vitest-Datei neben der Quelle.
3. **Neuer Kern-Code in Rust**; eine ersetzte TS-Fassung im selben Schritt
   löschen – keine Doppelspur.
4. **Prüfen:** `npm run check` grün. Sichtbare Änderungen ansehen (SVG aus
   der CLI, Browser-Build), nicht nur Zahlen vergleichen.
5. **Abschliessen:** kleine Commits; Nachricht auf Deutsch, beginnend mit den
   Nummern (`[63] Baurecht: …`). `TODO.md` im selben Commit nachführen
   (Stand, Datum, was offen bleibt). Gewollte Änderungen an Plan, Schnitt,
   Ansicht: Goldens neu schreiben und den Diff prüfen.
6. **Ehrlich berichten:** was geprüft wurde und was nicht (z. B. „nur im
   Linux-Container, nicht in der Tauri-App“).

## Konventionen

- Bezeichner englisch, Kommentare und Oberflächentexte deutsch.
- Oberflächentext nur über `t()` mit deutscher und englischer Fassung
  (`src/i18n/de.ts`, `en.ts`); ein Test findet fehlende Übersetzungen.
- Intern Meter; Strichstärken in Papier-Millimetern.
- Kein `window.alert/confirm/prompt` (im WKWebView von Tauri stumm), sondern
  `notify()` oder ein Overlay-Dialog.
- Netzzugriffe nur über `netFetch` (`src/net`).
- Das Projekt ändert sich nur über Ops (siehe [Rust-Kern](../kern/)).
- Neue Modellfelder nur im Rust-Modell, dann `npm run gen:types`.
- In gemeinsam genutzten Dateien (`lib.rs`, `web/mod.rs`, `Cargo.toml`,
  `src/core/index.ts`, `extra.ts`, `i18n/*.ts`, `TODO.md`) nur Zeilen
  ergänzen, nichts umordnen oder umformatieren – das hält parallele Arbeit
  zusammenführbar.
- macOS-Nebenfenster (Einstellungen, Ressourcen) sind eigene Dokumente ohne
  gemeinsamen Store; Zustand über die Sync-Brücke, nicht über `useStore`.

## Mit KI-Agenten

Dossier wird zu einem grossen Teil mit KI-Agenten (Claude Code) entwickelt.
Dafür sind `CLAUDE.md` (Regeln, Modulkarte, Grenzen) und `TODO.md`
(Aufgaben mit Abschlusskriterium) geschrieben. Agenten arbeiten in eigenen
Git-Worktrees und Branches; ein Koordinator führt zusammen, prüft und pusht.
Für menschliche Beiträge gelten dieselben Regeln.

## Fremdcode und Lizenz

- Dossier steht unter der **AGPL-3.0-or-later**. Beiträge werden unter
  derselben Lizenz aufgenommen.
- Übernommener Fremdcode trägt seine Herkunft im Dateikopf (Repository,
  Commit, Datei, Lizenz) und einen Eintrag in `NOTICE` [51]. Abhängigkeiten
  prüft `cargo deny` in der CI auf verträgliche Lizenzen.
- Normtexte (SIA, ISO, EN) gehören nicht ins Repository. Konventionen werden
  in eigenen Worten beschrieben und umgesetzt.
- Die mitgelieferten Materialtexturen stammen von ambientCG (CC0).

## Übersetzen

Die Oberfläche ist zweisprachig (Deutsch, Englisch). Neue Sprachen kommen als
weiteres Wörterbuch in `src/i18n/` dazu. Die Website ist vorerst deutsch;
eine englische Fassung ist geplant.
