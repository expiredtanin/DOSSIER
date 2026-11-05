---
title: "Kommandozeile"
linkTitle: "Kommandozeile"
weight: 13
---

`dossier-cli` ist derselbe Rechenkern wie die App, nur ohne Fenster. Damit
lassen sich Pläne, Exporte und Listen aus Skripten erzeugen, Dateien
umwandeln, Projekte prüfen – oder ein KI-Assistent an ein Projekt anbinden.
Nicht zu verwechseln mit der [Befehlszeile](../befehlszeile/) in der App.

## Bauen und aufrufen

Voraussetzung: Node.js und die gebauten WASM-Pakete
([Download](/download/)). Dann:

```bash
npm run build:cli
node dist-cli/dossier-cli.mjs <projekt.obp> <befehl> [optionen]
```

Ohne eigenes Projekt kann man die eingebauten Beispiele nutzen:
`:beispiel` (kleines Musterhaus) und `:musterhaus-komplex`.

```bash
node dist-cli/dossier-cli.mjs :musterhaus-komplex info
node dist-cli/dossier-cli.mjs :musterhaus-komplex migrate --out mk.obp   # als Datei speichern
```

## Pläne als SVG

```bash
# Grundriss Erdgeschoss 1:100 mit Schraffuren
dossier-cli haus.obp plan --level EG --scale 100 --hatch --out eg.svg
# Deckenspiegel
dossier-cli haus.obp plan --level EG --ceiling --out eg-dsp.svg
# Schnitt und Ansicht nach Namen, im Skizzenstil
dossier-cli haus.obp section "Schnitt A-A" --hatch --out schnitt.svg
dossier-cli haus.obp elevation "Ansicht Süd" --sketch --out sued.svg
```

- `--level` nimmt den Namen oder die Kennung des Geschosses; ohne Angabe das
  erste.
- `--hatch` zeichnet die Schraffurlinien aus (ohne: nur die Grundfüllung) –
  mit demselben Generator wie der PDF-Export der App.
- `--format json` gibt statt SVG die Szene des 2D-Renderers aus.

Die Bilder auf dieser Website sind so entstanden.

## Exporte

| Befehl | Ausgabe | Optionen |
|---|---|---|
| `dxf` | DXF | `--level`, `--scale 100`, `--dim-unit cm`, `--layout`, `--binary` |
| `dwg` | DWG | wie `dxf` |
| `ifc` | IFC | `--schema 4` oder `2x3`, `--ebkph` (eBKP-H-Klassifikation), `--ebenen` |
| `step` | STEP (B-Rep, mm) | – |
| `obj`, `stl` | Netz | – |
| `glb`, `gltf` | glTF 2.0 | `--flat` (ohne Geschoss-Knoten) |
| `model3d` | 3D-Modell als JSON für den Headless-Renderer | `--explode 3` |

## Kennzahlen und Listen

```bash
dossier-cli haus.obp kennzahlen --sia416 --ivhb --format pdf --out flaechen.pdf
dossier-cli haus.obp schedule --openings --format csv --out fenster-tueren.csv
dossier-cli haus.obp schedule --elements --format csv
dossier-cli haus.obp raumprogramm --import programm.xlsx --format pdf
dossier-cli haus.obp sun --when 2026-12-21T10:00Z --out schatten.json
```

- `kennzahlen`: Formate `json`, `csv`, `svg`, `pdf`; Optionen `--agsf`,
  `--gruenflaeche`, `--agf-basis gf|ngf|nf`, `--untergeschosse`.
- `raumprogramm`: `--import tabelle` (XLSX, ODS, CSV), `--sheet`,
  `--mode replace|append`, `--tolerance %`, `--generate` (Räume als
  Rechtecke erzeugen), `--save projekt.obp`.
- `sun`: Sonnenstand und Schattenpolygone für einen Zeitpunkt (UTC) als JSON.

## Umwandeln und importieren

```bash
# Kataster-DWG als Dossier-Projekt
dossier-cli convert kataster.dwg kataster.obp
# Projekt nach IFC, danach weitere Befehle auf das Ergebnis
dossier-cli convert haus.obp haus.ifc
# Vektor-PDF als 2D-Zeichnung (Massstab des Plans angeben)
dossier-cli convert plan.pdf plan.obp --scale 100 --page 1
# IFC in ein bestehendes Projekt: als Kontext oder als Bauteile
dossier-cli haus.obp import-ifc nachbar.ifc --out neu.obp --elements
dossier-cli haus.obp import-mesh umgebung.glb --unit m --up auto --out neu.obp
```

Das Zielformat ergibt sich aus der Dateiendung. Mit `--cmd "…"` lassen sich
weitere CLI-Befehle an das Ergebnis hängen; `{last}` steht für die zuletzt
geschriebene Datei.

## Prüfen und messen

| Befehl | Zweck |
|---|---|
| `info` | Übersicht: Anzahl Bauteile, Geschosse, Schnitte, Ansichten |
| `validate` | Projekt gegen das Modell prüfen (Ausgabe `ok` oder Fehler) |
| `migrate --out neu.obp` | Datei ins aktuelle Format überführen |
| `bench [--runs 10]` | Zeitprofil der Ableitungen in ms |
| `bench --big` | dasselbe an einem erzeugten Grossgebäude |
| `pdf-info`, `pointcloud-info`, `bcf-info` | Inhalt einer Datei als JSON |

## KI-Zugriff (MCP)

Dossier spricht das **Model Context Protocol**. Ein KI-Assistent (etwa Claude
Desktop oder Claude Code) kann damit Projekte abfragen und ändern.

**Auf eine Datei:** `dossier-cli haus.obp mcp` startet einen MCP-Server
(stdio) auf der Datei.

**Auf das offene Projekt in der App:**

1. In Dossier *Fenster → Einstellungen → KI-Zugriff* „KI-Zugriff erlauben“
   einschalten. Der Zugriff ist standardmässig aus und nur lokal
   (127.0.0.1) erreichbar; die App zeigt einen Schlüssel und die passende
   Zeile für den MCP-Client.
2. Im MCP-Client eintragen, z. B. in `claude_desktop_config.json`:

```json
{ "mcpServers": { "dossier": { "command": "node",
  "args": ["/pfad/zu/dist-cli/dossier-cli.mjs", "mcp", "--app", "--token", "<schlüssel>"] } } }
```

Der Schlüssel gilt bis zum Beenden der App. Die Werkzeuge: Abfragen
(Auswahl, Geschosse, Elemente, Kennzahlen, Listen), Befehle mit
JSON-Parametern, Auswahl und Zoom, Export (SVG, PDF, IFC; Speichern nur über
den Dialog). Jede Änderung ist ein eigener Undo-Schritt „KI: …“ und steht im
**KI-Protokoll** unten links; dort lässt sich die KI auch pausieren.
