# Dossier

Dossier ist ein CAD-Programm für Architektur. Man modelliert ein Gebäude aus
Bauteilen – Wände, Decken, Dächer, Treppen, Fenster, Türen, Räume – und
bekommt daraus Grundrisse, Schnitte, Ansichten, ein 3D-Modell und fertige
Planblätter. Dazu gibt es ein 2D-Zeichenprogramm mit Befehlszeile, wie man es
von Rhino oder AutoCAD kennt.

Entstanden ist es aus dem Rhino-Plugin
[DOSSIER](https://git.openbureau.ch/karim/dossier). Die Arbeitsweise ist
dieselbe geblieben (Geschosse, Kategorie-Ebenen, mehrschichtige Bauteile,
Verschneidung nach Priorität), aber Dossier ist heute ein eigenständiges
Programm mit eigenem Datenmodell und eigenen Renderern. Es ist Teil der
openbureau-Suite und richtet sich an die Praxis in der Schweiz: LV95,
swisstopo, SIA 416, Kataster als DWG.

Hauptplattform ist macOS (Tauri), Linux läuft über Electron. Fertige
Installer gibt es noch nicht.

## Wie es funktioniert

Es gibt genau ein Modell. Alles andere wird daraus abgeleitet und nie von Hand
nachgeführt: Verschiebt man eine Wand, stimmen Grundriss, Schnitt, Ansicht,
3D, Mengen und IFC sofort wieder.

Der Grundriss wird nicht aus einem 3D-Netz geschnitten, sondern aus den
Bauteilen berechnet (Wandachse und Schichten ergeben Linien und Füllungen,
Öffnungen ergeben Lücke und SIA-Symbol). Schnitte verschneiden die Bauteile
nach derselben Priorität wie der Grundriss. Strichstärken, Schraffuren,
Farben und Detailgrad kommen erst beim Zeichnen dazu; das PDF ist derselbe
Plan wie am Bildschirm, nur mit echten Stiftstärken in Millimetern.

Gerechnet wird in einem Kern in Rust. Er hält das Projekt, prüft jede
Änderung, führt Rückgängig/Wiederholen und erzeugt Pläne, 3D und Exporte.
Die Oberfläche (React/TypeScript) kümmert sich nur um Bedienung und Anzeige.
Angezeigt wird über zwei eigene Renderer, ebenfalls in Rust: `render2d` für
Pläne und `render3d` für 3D, über WebGPU bzw. auf dem Mac nativ über Metal.

## Was es kann

**Bauteile.** Wände mit beliebig vielen Schichten und sauberen L-, T- und
X-Anschlüssen; Fenster und Türen mit Rahmen, Flügeln, Sprossen, Oberlicht und
Storenkasten; Decken mit Aussparungen; Flach-, Pult-, Sattel-, Walm-, Zelt-
und Mansarddächer, auch über unregelmässigen Grundrissen und mit Innenhöfen;
gerade, L- und Wendeltreppen mit Podest und Geländer; Stützen; Räume nach
SIA 416 mit Raumstempel und Flächenbilanz. Für Sonderfälle gibt es echte
Volumenkörper (B-Rep über [truck](https://github.com/ricosjp/truck)) mit
Booleans, und Abzugskörper für Durchbrüche, Nischen und Schlitze.

**Zeichnen.** Linien, Polylinien mit Bögen, Kreise, Ellipsen, Splines, Texte
mit Formatierung, Bemassung, Höhenkoten, Detailverweise, Revisionswolken,
Schraffuren und Bilder. Bearbeiten mit Verschieben, Drehen, Spiegeln,
Versetzen, Stutzen, Dehnen, Verrunden, Fasen, Verbinden und so weiter. Rund
55 Befehle mit deutschen und englischen Kürzeln, Eingabe von Koordinaten
(`5,3`, `r5,3`, `5<45`), Fang, Griffe und ein Verlauf, in dem man zu jedem
früheren Schritt zurückspringen kann.

**Pläne.** Grundriss je Geschoss mit Referenzgeschossen und Darstellungsmodi,
Schnitte und Ansichten aus Schnittlinien, 3D mit Live-Schnitt. Layoutblätter
mit mehreren Ansichtsfenstern, Masterlayouts mit Rahmen und Titelblock;
gezeichnet wird auf dem Blatt genau gleich wie im Grundriss. Ausgabe als
Vektor-PDF oder ganzer Plansatz.

**Darstellung.** Stiftsätze wie in ArchiCAD, Bauteil-, Schraffur- und
Linienstil-Bibliotheken (inkl. `.lin`/`.pat`), Regeln, die Farbe und
Strichstärke nach Ebene oder Element überschreiben, Farbmanagement mit ICC.

**Ort und Analyse.** Kataster und Pläne als DXF/DWG in Landeskoordinaten,
Gelände, Gebäude und Orthofoto von swisstopo, Kontext aus OpenStreetMap,
Sonnenstand und Schattenwurf, Baurechts-Prüfung, Kennzahlen und
Raumprogramm (auch aus einer Tabelle importiert).

## Dateiformate

| | Import | Export |
|---|---|---|
| DXF, DWG | ja (R12–2018, auch sehr grosse Kataster) | ja, mit Layouts |
| IFC | ja, als Bauteile oder als Kontext | IFC4 und IFC2x3, mit Schichten, Öffnungen, Räumen |
| STEP | ja | ja (B-Rep, in mm) |
| OBJ, STL, glTF/GLB, PLY | ja | ja (ohne PLY) |
| PDF | Vektoren und als Bild | Plan und Plansatz |
| SVG, CSV | – | Plan, Bauteil- und Flächenlisten |

Das eigene Format ist `.obp` (JSON).

## Bauen

Benötigt werden Node.js, Rust mit dem Target `wasm32-unknown-unknown` und für
die Desktop-App die [Tauri-Voraussetzungen](https://tauri.app/start/prerequisites/).
Die WASM-Pakete liegen nicht im Repository und müssen einmal gebaut werden:

```bash
git clone https://github.com/expiredtanin/DOSSIER.git
cd DOSSIER
npm install
npm run build:core && npm run build:fileio && npm run build:engine \
  && npm run build:engine3d && npm run build:truck

npm run tauri:dev     # macOS
npm run electron      # Linux
npm run dev           # nur im Browser, für Entwicklung
```

Prüfen: `npm run check` (TypeScript, Vitest und die Rust-Tests aller Crates),
`npm run e2e` für die Oberflächentests mit Playwright.

## Releases

Ein Release entsteht aus einem Tag: Version in `src-tauri/tauri.conf.json` anheben, committen, dann
`git tag v0.2.0 && git push origin v0.2.0`. `.github/workflows/release.yml` baut die macOS-App (Tauri,
universal arm64 + x64) und legt einen **Release-Entwurf** mit den Artefakten und einer Änderungsliste
(Commit-Titel seit dem letzten `v*`-Tag) an; der Entwurf wird von Hand veröffentlicht. Ohne Secrets
entstehen unsignierte Artefakte. Optionale Repository-Secrets:

- Signierung/Notarisierung: `APPLE_CERTIFICATE` (base64 der .p12), `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (App-spezifisch), `APPLE_TEAM_ID`
- Updater-Signatur: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  (passend zum `pubkey` in `tauri.conf.json`; ohne Schlüssel entfallen die Updater-Artefakte)

Der Updater-Endpunkt in `tauri.conf.json` zeigt noch auf `git.openbureau.ch`; soll er GitHub nutzen,
dort `…/releases/latest/download/latest.json` eintragen. Linux (Electron) hat keinen Release-Build.

## Kommandozeile

`dossier-cli` benutzt denselben Kern wie die App, nur ohne Fenster. Gebaut wird
sie mit `npm run build:cli`:

```bash
node dist-cli/dossier-cli.mjs haus.obp plan --scale 100 --out eg.svg
node dist-cli/dossier-cli.mjs haus.obp ifc --out haus.ifc
node dist-cli/dossier-cli.mjs kataster.dwg convert --out kataster.obp
node dist-cli/dossier-cli.mjs haus.obp kennzahlen
```

Weitere Befehle: `section`, `elevation`, `dxf`, `dwg`, `step`, `glb`,
`schedule`, `sun`, `validate`, `bench` und `mcp`, mit dem ein KI-Assistent das
Projekt abfragen und ändern kann.

### KI-Assistent am offenen Projekt (MCP)

`dossier-cli … mcp` arbeitet auf einer Datei. Für das in der App **offene**
Projekt: in Dossier unter *Fenster → Einstellungen → KI-Zugriff* „KI-Zugriff
erlauben“ einschalten (aus per Vorgabe, nur 127.0.0.1) und die angezeigte Zeile
im MCP-Client eintragen, z. B. in Claude Desktop (`claude_desktop_config.json`)
bzw. mit `claude mcp add dossier -- node …/dossier-cli.mjs mcp --app --token …`:

```json
{ "mcpServers": { "dossier": { "command": "node",
  "args": ["/pfad/zu/dist-cli/dossier-cli.mjs", "mcp", "--app", "--token", "<schlüssel>"] } } }
```

Der Schlüssel gilt bis zum Beenden der App. Werkzeuge: Abfragen (Auswahl,
Geschosse, Elemente, Kennzahlen, Listen), Befehle mit JSON-Parametern, Auswahl
und Zoom, Export (SVG/PDF/IFC; Speichern nur über den Dialog). Jede Änderung ist
ein Undo-Schritt „KI: …“ und steht im KI-Protokoll unten links, dort lässt sich
die KI auch pausieren.

## Aufbau

```
src/               Oberfläche (React/TypeScript)
  ui, panels, views, viewport, commands, tools, state …
  model, plan, geometry, io, export …   dünne Schicht über dem Rust-Kern
src-tauri/
  core/            Kern: Modell, Änderungen, Verlauf, Pläne, 3D, Exporte
  fileio/          DXF/DWG, IFC, PDF, Meshes
  render2d/        Plan-Renderer
  render3d/        3D-Renderer
  kernel2d/        2D-Geometrie
  trucksolid/      Volumenkörper (truck)
  src/             Tauri: Fenster, Menüs, native Plan-Anzeige auf macOS
e2e/               Oberflächentests
website/           Dokumentation (Hugo)
```

Wer mitarbeiten will: Arbeitsregeln stehen in [`CLAUDE.md`](CLAUDE.md), der
Stand der Arbeit in [`TODO.md`](TODO.md).

## Lizenz

© 2026 Karim Gabriele Varano, veröffentlicht unter der
[GNU Affero General Public License v3.0 oder später](LICENSE). Wer Dossier
verändert und als Netzwerkdienst anbietet, muss den Quellcode ebenfalls
offenlegen. Fremdkomponenten behalten ihre eigenen Lizenzen (siehe
[`NOTICE`](NOTICE)); die mitgelieferten Materialien von ambientCG sind CC0.
