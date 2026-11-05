---
title: "Probleme und Grenzen"
linkTitle: "Probleme und Grenzen"
weight: 15
---

Dossier ist vor der ersten öffentlichen Beta. Diese Seite sagt, was man bei
Problemen tun kann und was bekanntermassen noch fehlt.

## Wenn etwas nicht geht

**Das 3D-Fenster bleibt leer.** Die 3D-Anzeige braucht WebGPU (auf dem Mac
Metal). Im Browser: aktuelles Chrome/Chromium mit WebGPU verwenden. Unter
Linux die Electron-Fassung nehmen. Grundriss, Schnitt, Ansicht und Layout
funktionieren auch ohne WebGPU.

**Ein Befehl reagiert nicht wie erwartet.** Esc drücken – das bricht jeden
Befehl gleich ab. Die Befehlszeile zeigt, was der Befehl gerade erwartet;
Optionen stehen daneben. Ist nichts gewählt, fragen Bearbeiten-Befehle erst
nach der Auswahl.

**Ein Element lässt sich nicht wählen.** Ist die Ebene gesperrt oder
ausgeblendet (Panel *Ebenen*)? Liegt es auf einem anderen Geschoss? Mehrere
Elemente übereinander: Mod+Klick wählt das nächste darunter.

**Der Grundriss zeigt ein Bauteil nicht.** Ansichtsbereich prüfen
(Geschoss-Editor): Liegt das Bauteil über der *Oberkante Sicht* oder unter
*Darunter sichtbar bis*, wird es weggelassen. Ebenen-Kombination und Regeln
des Ausschnitts können Ebenen ausblenden.

**Ein Mass zeigt einen roten Punkt.** Der Bezug ist verloren (Bauteil
gelöscht oder stark verändert). Die Objekt-Info listet den Punkt; neu fangen
oder mit *Bemassung lösen* frei machen.

**Swisstopo oder OpenStreetMap laden nicht.** Netzverbindung prüfen und ob
der Offline-Modus aus ist (*Einstellungen → Allgemein → Netzwerk*).

**Eine Datei ist gesperrt.** Dossier sperrt geöffnete `.obp`-Dateien. Ist
die Datei anderswo offen (der Dialog nennt Rechner und Prozess) oder ist
die App abgestürzt, bietet der Dialog *Schreibgeschützt öffnen* oder
*Trotzdem erzwingen*.

**Nach einem Absturz.** Beim nächsten Start bietet Dossier die
automatische Sicherung an (alle 30 Sekunden). Die vorige gespeicherte
Fassung liegt zudem als `datei.obp~` neben der Datei.

**Fehler im Rechenkern.** Stösst der Kern auf einen internen Fehler, startet
er neu, lädt den letzten Stand und meldet das. Bitte dann ein Issue mit den
Schritten dorthin melden.

## Fehler melden

Fehler und Wünsche bitte als
[Issue auf GitHub](https://github.com/expiredtanin/DOSSIER/issues), möglichst
mit:

- Version bzw. Commit (*Über dossier* oder `git log -1`),
- Plattform (macOS-App, Linux/Electron, Browser),
- Schritten zum Nachstellen und – wenn möglich – einer kleinen `.obp`-Datei.

## Bekannte Grenzen

Stand 5.11.2026; die vollständige Liste führt
[`TODO.md`](https://github.com/expiredtanin/DOSSIER/blob/master/TODO.md).

**Installation und Plattform**

- Keine signierten Installer; man baut aus dem Quellcode. Linux ohne
  Release-Build. Windows ist nicht geprüft.
- Im Browser keine Dateisperre, keine nativen Dialoge, keine Liste der
  zuletzt geöffneten Projekte.

**Bedienung**

- Zeichnungs-Reiter werden nicht im Projekt gespeichert [136].
- Ziehen von Griffen mit Fang ist im 3D noch nicht vollständig.

**Modell und Pläne**

- Einige schräge mehrschichtige Wandanschlüsse [108] und schiefwinklige
  Dachgrundrisse [26] sind noch nicht in jedem Fall sauber.
- Fenster- und Türdetails: viele Konstruktionsarten vorhanden, einzelne
  Darstellungen in Schnitt und 3D noch in Arbeit [94]–[106].
- Ansichtsbereich: noch nicht jede Bauteilart hat jede Zone [36].
- Schnitte und Ansichten: einzelne Darstellungen (Dachstirnen,
  Sonderfälle) werden noch verfeinert [115], [132].
- Kein Phasenmodell (Bestand/Abbruch/Neu) und keine Varianten.

**Analyse und Lage**

- Schatten nur im Grundriss, nicht im 3D [64].
- Baurecht vereinfacht; ersetzt nicht die Prüfung nach der geltenden Bau-
  und Zonenordnung.

**Austausch**

- DXF/DWG werden als 2D gelesen, nicht als Wände und Öffnungen.
- IFC-Import zu Bauteilen erkennt nicht alles [B4].
- Punktwolken nur zur Anzeige im 3D [27].
- PDF-Import: verschlüsselte PDFs werden abgelehnt [76].
