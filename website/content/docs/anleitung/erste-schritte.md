---
title: "Erste Schritte"
linkTitle: "Erste Schritte"
weight: 1
---

Dieses Kapitel führt in einer Viertelstunde vom leeren Projekt zur ersten Wand
mit Fenster, zum Schnitt und zum PDF. Installation: [Download](/download/).

## Starten

Nach dem Start zeigt Dossier den Startbildschirm:

- **Neues Projekt** legt ein leeres Projekt an – mit Geschossen, Standard-
  Baustoffen, Schraffuren, Linientypen und Ansichtsvorlagen.
- **Projekt öffnen …** öffnet eine `.obp`-Datei.
- In der Desktop-App erscheinen darunter die zuletzt geöffneten Projekte.

Wurde Dossier zuletzt nicht sauber beendet, bietet es die automatische
Sicherung zur Wiederherstellung an (gesichert wird alle 30 Sekunden, solange
ungespeicherte Änderungen bestehen).

## Mit dem Musterhaus beginnen

Am schnellsten lernt man an einem fertigen Projekt. Unter
**Datei → Neu aus Vorlage** gibt es zwei Beispiele:

- **Musterhaus** – ein kleines Haus mit zwei Geschossen.
- **Musterhaus (komplex)** – vier Geschosse (UG bis DG), gebogene Wand, Dach
  mit Gauben, Treppen, 22 Räume, Schnitte A-A und B-B, vier Ansichten,
  Situation mit Gelände und Parzellen, Layoutblätter und Publikationssätze.

Im Panel **Ausschnitte** (rechts) liegen die gespeicherten Ansichten des
Musterhauses: ein Klick zeigt „EG 1:100“, „Schnitt A-A“ oder „Ansicht Süd“
im aktiven Reiter, ein Doppelklick öffnet sie in einem neuen Reiter.

![Musterhaus komplex: Schnitt A-A in der App](/img/app-schnitt.webp)

## Die erste Wand

1. Im Panel **Zeichnungsebenen** das Geschoss wählen, z. B. „Erdgeschoss“.
2. Den Befehl **Wand** starten: Taste `6`, das Werkzeug links in der Liste
   oder in der Befehlszeile `w` und Enter tippen.
3. Ersten Punkt klicken oder tippen: `0,0` und Enter.
4. Nächster Punkt: `r8,0` (8 m nach rechts), dann `r0,6`, dann `r-8,0`,
   dann `0,0`.
5. Enter beendet den Wandzug, Esc bricht ab.

Während des Befehls zeigt die Befehlszeile Optionen (*Zurück*, *Bogen* für
gebogene Wände, *Tangential*) und Felder für Länge, Winkel und Dicke; Tab
springt zwischen den Feldern. Der Wandtyp (Schichtaufbau) ist der aktive Typ
aus dem Panel **Attribute**. Die Ecken verbinden sich von selbst nach der
Priorität der Schichten.

## Fenster und Tür einsetzen

1. **Fenster** (Taste `8` oder `f`) wählen, dann die Wand anklicken; die Lage
   entlang der Wand folgt der Maus, Tab springt in die Felder für Abstand,
   Breite und Brüstung.
2. **Tür** (Taste `9` oder `t`) genauso; Anschlag und Aufschlagrichtung wählt
   man mit den Optionen der Befehlszeile oder später in der Objekt-Info.

Fenster und Türen sind Typen aus der Bibliothek. Wer die Konstruktion ändern
will (Rahmen, Flügel, Anschlag, Leibung), öffnet den Typ im
**Ressourcen-Manager** (Menü *Fenster → Ressourcen*), siehe
[Bauteile](../bauteile/#fenster-und-türen).

## Decke, Raum, Dach

- **Decke** (`7` oder `d`): Umriss Punkt für Punkt zeichnen, mit der Option
  *Schliessen* abschliessen.
- **Raum** (`0` oder `raum`): in einen Raum klicken; Dossier findet den
  Umriss aus den Wänden und setzt den Raumstempel mit Fläche.
  Mit der Option *Modus* zeichnet man den Umriss stattdessen von Hand.
- **Dach** (`dach`): Umriss zeichnen, Dachform und Neigung wählen.

## Schnitt und 3D

- Befehl **Schnittlinie** (`schnittlinie`): zwei Punkte durch das Gebäude,
  dann die Blickrichtung. Der Schnitt erscheint als eigene Ansicht in den
  Zeichnungsebenen und lässt sich wie ein Ausschnitt öffnen.
- Oben links in der Leiste wechseln die Knöpfe zwischen Grundriss und 3D;
  das 3D folgt dem aktuellen Modell.

## Speichern und ausgeben

- **Datei → Speichern unter …** (Cmd/Strg+S) schreibt eine `.obp`-Datei.
  Gespeichert wird absturzsicher: erst in eine Zwischendatei, die vorige
  Fassung bleibt als `datei.obp~` liegen.
- **Datei → Exportieren → PDF** gibt die aktuelle Ansicht als Vektor-PDF aus;
  für Planblätter siehe [Layout und Publikation](../layouts/).

## Wie es weitergeht

- [Oberfläche](../oberflaeche/) – was wo ist.
- [Befehlszeile](../befehlszeile/) – alle Befehle und Kürzel.
- [Bauteile](../bauteile/) – Wände, Öffnungen, Dächer, Treppen im Detail.
