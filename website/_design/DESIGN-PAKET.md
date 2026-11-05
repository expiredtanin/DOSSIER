# Dossier Website: Design-Paket (Startseite)

Stand 5.11. Vorlage: das „10K Websites“-Paket (Scroll-Hero, Qualitätsboden, Selbsttest), angepasst:
Hero aus echten Dossier-Bildern statt KI-Video, Hosting über GitHub Pages, Startseite statisch,
Dokumentation dahinter (Hugo, gleicher Look). Alle Texte unten gehen wörtlich in die Seite.

## 1. Grundidee

Ein Wort aus der Welt der Architektur: **das Modell**. Wer plant, zeichnet heute denselben Bau
fünfmal: Grundriss, Schnitt, Ansicht, Liste, Blatt. Dossier dreht das um. Man baut ein Modell aus
Bauteilen, und jeder Plan wird daraus berechnet. Die ganze Seite lehrt diese eine Idee: Ein Strich
wird zur Wand, die Wand zum Haus, das Haus zu allen Plänen. Schlusssatz sagt sachlich, was es ist: „Open-Source-CAAD“ mit der Zeile „Computer-Aided Architectural Design“ darunter.

## 2. Farben (aus den eigenen Plänen genommen)

Papier, Tusche, Schraffurgrau und das Rot, mit dem Dossier Fenster und Öffnungen zeichnet.

```css
:root{
  --canvas:#f2f0e9;        /* Planpapier, leicht warm, nie reines Weiss */
  --panel:#fbfaf5;         /* Karten, erhöhte Flächen */
  --accent:#b3362b;        /* Öffnungsrot aus den Plänen: Download-Knopf, Fokus, seltene Betonung */
  --accent-hover:#952b22;
  --accent-muted:rgba(179,54,43,.14);
  --text-secondary:#5a5f66;
  --text-primary:#1c1f23;  /* Tusche */
  --hatch:#c9c6bd;         /* Schraffur- und Rasterlinien */
}
/* Dunkel: Lichtpause */
:root[data-theme="dark"]{
  --canvas:#15181c; --panel:#1d2126; --accent:#e0675b; --accent-hover:#ee8277;
  --accent-muted:rgba(224,103,91,.16); --text-secondary:#a3a8ae; --text-primary:#ecebe6; --hatch:#3a3f46;
}
```

Bewusste Abweichung, offen gesagt: Das Paket nennt „heller Grund mit Rotton“ als Klischee. Hier ist
es die echte Welt des Produkts (Planpapier, Öffnungsrot aus Dossier selbst). Dafür keine Serifen-
schrift, keine Terrakotta, und ein eigenes Erkennungselement (s. 7).

## 3. Schriften (alle frei lizenziert, selbst gehostet, nur benutzte Schnitte)

- **Anzeige:** Schibsted Grotesk 600 und 800. Eine Groteske mit Charakter, nah an Schweizer Plan-Typografie.
- **Text:** IBM Plex Sans 400 und 500. Ruhig, gut lesbar.
- **Klein und Masse:** IBM Plex Mono 400. Für Kotenangaben, Massstäbe, Labels („1:100“, „±0.00“).

## 4. Scroll-Abschnitte (Hero, ca. 900vh)

Das Video entsteht aus echten Dossier-Renderings des Musterhauses komplex (CLI, Linux), als
Bildfolge mit ffmpeg zu einem Scroll-Video gebaut (Keyframe alle 8 Bilder). Die Handlung liegt in
der Mitte und rechts; die Texte stehen links im ruhigen Papierbereich. Bereiche sind Startwerte,
der Wischtest (120/240/360 px) entscheidet.

| Abschnitt | Bereich | Was das Bild zeigt | Text (wörtlich) | Auftritt |
|---|---|---|---|---|
| 1 | 0.00–0.16 | Leeres Blatt mit Raster, die ersten Wandlinien ziehen sich | „Zeichne eine Wand.“ | Zeichen setzen sich wie Striche von links nach rechts (Raster-Einrasten) |
| 2 | 0.18–0.36 | Wände schliessen sich, Öffnungen erscheinen rot | „Dossier weiss, dass es eine Wand ist. Mit Schichten, Fenstern, Türen.“ | Wörter rasten ein wie Fangpunkte (kurzes Überschwingen) |
| 3 | 0.38–0.56 | Schraffur füllt die Wände, Masse und Räume erscheinen | „Der Grundriss rechnet sich selbst. Schraffur, Masse, Flächen.“ | Wörter fallen zeilenweise ein, wie Masslinien gesetzt werden |
| 4 | 0.58–0.78 | Schnittlinie A–A läuft über den Plan, der Schnitt klappt hoch | „Schnitt und Ansicht kommen aus demselben Modell.“ | Hälften öffnen sich von der Mitte aus, wie der Schnitt |
| 5 | 0.80–1.00 | Ruhe: Ansicht Süd und Grundriss nebeneinander auf einem Blatt | „Open-Source-CAAD“ (darunter in Mono: „Computer-Aided Architectural Design“) + Knopf „Dossier herunterladen“ + Link „Anleitung lesen“ | Wort für Wort aufsteigen, dann Unterzeile, dann Knöpfe |

## 5. Startseite ohne Video (Telefone, reduzierte Bewegung)

Bild: das Schlussbild (Blatt mit Grundriss und Ansicht).
- Titel: „Open-Source-CAAD“
- Zeile darunter (Mono): „Computer-Aided Architectural Design“
- Unterzeile: „Dossier ist ein freies CAD für Architektur. Du baust ein Gebäude aus Bauteilen, Grundriss, Schnitt und Ansicht werden daraus berechnet.“
- Knopf: „Dossier herunterladen“

## 6. Abschnitte unter dem Hero (alle führen zum einen Ziel: herunterladen)

1. **So arbeitet Dossier** (3 Schritte mit je einem echten Bild)
   - „Zeichnen.“ Linien, Wände, Öffnungen, mit Fang und Befehlszeile.
   - „Modellieren.“ Wandtypen mit Schichten, Decken, Dächer, Treppen, Gelände.
   - „Publizieren.“ Pläne auf Blätter legen, PDF mit Ebenen, DXF, IFC.
2. **Was alles drin ist** (Funktionsraster, je eine Zeile, Screenshot beim Darüberfahren)
   Grundriss, Schnitt, Ansicht, Deckenspiegel · Bemassung, auch automatisch · Fenster- und Türliste ·
   Baurecht mit Grenzabständen und Gebäudeprofil · Gelände aus Höhenlinien, Swisstopo · Sonne und Schatten ·
   DXF, DWG, IFC, STEP, PDF · Skizzenstil und Präsentationsplan.
3. **Gemacht für die Schweizer Praxis**
   „Schraffuren und Linientypen nach SIA-Konventionen, Koordinaten in LV95, Höhen ab ±0.00, Kataster und
   Höhenmodell von Swisstopo.“ (SIA nur in eigenen Worten beschrieben, keine Normtexte.)
4. **Das eine Erlebnis: Schnitt setzen.** Unter einem Grundriss liegt ein Regler. Wer die Schnittlinie
   über das Haus zieht, sieht den Schnitt an dieser Stelle (vorgerenderte Schnitte, 12 Positionen).
   Text: „Zieh die Linie. Der Schnitt folgt.“ Mit reduzierter Bewegung: direkt der mittlere Schnitt.
5. **Frei und offen**
   „Dossier ist freie Software unter AGPL-3.0. Kein Konto, keine Cloud, kein Abo. Deine Projekte sind
   Dateien auf deinem Rechner, lesbar und versionierbar.“
6. **Ehrlicher Stand** (aus TODO.md: was fertig ist, was halb)
   „Dossier ist jung. Vieles ist fertig, einiges erst halb. Hier steht genau, was.“ Link zur Stand-Seite.
7. **Fragen**
   - „Läuft Dossier auf meinem Rechner?“ macOS als Hauptplattform, Linux über Electron. Windows: ehrlich, wie der Stand ist.
   - „Kann ich DWG und DXF öffnen?“ Ja, Import und Export; Grenzen nennen.
   - „Kann ich mit anderen Programmen IFC austauschen?“ Ja, IFC4 und 2x3; geprüft mit IfcOpenShell.
   - „Kostet das etwas?“ Nein. Freie Software, auch für Büros.
   - „Ist es fertig?“ Nein, aber brauchbar für Entwurf und Eingabe. Was fehlt, steht im Stand.
8. **Schluss:** „Fang mit einer Wand an.“ + Knopf „Dossier herunterladen“ (GitHub Releases) + „Anleitung lesen“.
9. **Fusszeile:** Lizenz, Quellcode auf GitHub, Impressum/Kontakt (openbureau), Dokumentation, Stand.
   Kein Formular (statische Seite; der Download ist das Ziel).

## 7. Vektor-Ebene und Erkennungselement

- **Erkennungselement: die Schnittmarke.** Abschnittswechsel sind als Schnittlinien mit Pfeilen und
  Buchstaben gezeichnet (A–A, B–B, …), die sich beim Hineinscrollen selbst zeichnen. Ohne sie wäre die
  Seite eine gewöhnliche Produktseite.
- Feines Planraster als fester Hintergrund (eine Ebene, sehr langsame Drift über 90 s).
- Masslinien als Trenner: Linie mit Endmarken und einer Mono-Kote (z. B. „17.39“).
- Je Abschnitt ein leises lebendiges Element (z. B. ein Fangpunkt, der langsam pulsiert).
- Alles respektiert reduzierte Bewegung: Endzustand sichtbar, nichts läuft.

## 8. Technik (aus dem Paket, vollständig)

Video als Blob mit Ladering, geglättete Zeit im rAF-Takt, der ruht, gegatete Seeks, DOM nur bei
Änderung, Abschnitte in Scroll-Distanz mit Wischtest, vier Lesbarkeits-Ebenen (Papier-Scrim statt
dunkel), fünf Bedingungen für die Startseite ohne Video live in CSS und JS, Seite vollständig ohne
Video, Qualitätsboden (Kontrast, Landmarks, Fokus, Touch-Ziele, Titel, Favicon), Selbsttest-Liste.
Ohne externe Abrufe: Schriften und Bilder liegen im Repo.

Hosting: GitHub Pages aus `website/` per Actions-Workflow (Hugo baut die Doku, die Startseite liegt als
statisches `index.html` daneben). Domain dossier.openbureau.ch per CNAME, wenn gewünscht.

## 9. Textprüfung

Alle Texte oben gehen wörtlich in die Seite. Vor dem Zeigen: keine Gedankenstriche, keine Floskeln
(nahtlos, robust, Lösungen, entfesseln, …), keine „nicht nur X, sondern Y“-Sätze.
