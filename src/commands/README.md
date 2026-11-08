# src/commands

Befehle im Stil von Rhino und AutoCAD. Ein Befehl ist ein kleiner Zustandsautomat: jeder Schritt zeigt
eine Aufforderung, nimmt Punkte, Zahlen, Optionen oder eine Auswahl an und liefert eine Vorschau und am
Ende eine Änderung. Maus-Klicks und getippte Eingaben (`5,3`, `r5,3`, `5<45`) speisen denselben Schritt.

Gerechnet wird im Rust-Kern: neue Elemente und Vorschau in `src-tauri/core/src/cmd_create.rs`
(Zeichenbefehle), `cmd_draw.rs`, `cmd_edit.rs`, `cmd_transform.rs`, `cmd_solid.rs`, `cmd_wall_edit.rs`;
Einstieg `commands.rs`. Hier bleiben nur die Abläufe. Ein Beispiel von Klick bis Kern steht in
`doc/ARCHITEKTUR.md`, Abschnitt 9.

## Dateien

| Datei | Inhalt |
|---|---|
| `types.ts` | Verträge: `Command`, `CommandState`, `CommandContext` (Projekt, Ebene, Auswahl), `CommandResult` (Vorschau, `commit`, `done`) |
| `engine.ts` | `CommandEngine`: hält den aktiven Befehl, verteilt Eingaben (`pick()`, `move()`, `submitText()`), Fang über den Host, Esc/Enter, letzter Befehl |
| `registry.ts` | `COMMANDS` (Name → Befehl), Kürzel, `resolveCommand()` (Name, Nutzer-Kürzel, eingebautes Kürzel, Präfix) |
| `parseInput.ts` | Parser der Befehlszeile: absolute, relative und polare Koordinaten, Zahlen, Optionen |
| `createCore.ts` | Brücke zum Kern: `createMutation()` (Commit als Kern-Anfrage), `createPreview()` (Vorschau je Mausschritt), `createQuery()` |
| `cmds/` | ein Modul je Befehl, Test daneben |

Die Brücke für Editier-Befehle und Vorschau-Formen liegt in `src/tools/coreCmd.ts`. Wo die Engine lebt und
wie ihr Ergebnis in den Store gelangt: `src/state/useCommandEngineHost.ts`.

## Befehle in `cmds/` (Auswahl)

| Gruppe | Module |
|---|---|
| Bauteile | `wall.ts`, `opening.ts`, `ceiling.ts`, `ceilingOpening.ts`, `roof.ts`, `roofHole.ts`, `roofWindow.ts`, `dormer.ts`, `stair.ts`, `column.ts`, `room.ts`, `grid.ts`, `tree.ts`, `terrain.ts`, `excavation.ts` |
| Körper | `solid.ts`, `solidbool.ts`, `voidbox.ts`, `extrude.ts`, `revolve.ts`, `loft.ts` |
| 2D zeichnen | `line.ts`, `xline.ts`, `ray.ts`, `polyline.ts`, `polygon.ts`, `rect.ts`, `circle.ts`, `arc.ts`, `ellipse.ts`, `bezier.ts`, `spline.ts`, `multiline.ts`, `revcloud.ts`, `wipeout.ts`, `block.ts`, `defblock.ts` |
| Beschriften | `text.ts`, `textbox.ts`, `textpath.ts`, `leader.ts`, `dimension.ts`, `dimround.ts`, `dimdetach.ts`, `autodim.ts`, `kote.ts`, `detailref.ts`, `pointmarker.ts`, `scalebar.ts`, `sectionline.ts` |
| Bearbeiten | `transform.ts` (Bewegen, Drehen, Spiegeln), `copy.ts`, `scale.ts`, `array.ts`, `align.ts`, `offset.ts`, `trim.ts`, `extend.ts`, `fillet.ts`, `chamfer.ts`, `cornerHit.ts`, `break.ts`, `split.ts`, `join.ts`, `explode.ts` |
| Sonstiges | `measure.ts`, `wand.ts` (Zauberstab), `recognize.ts` (Bauteile aus Zeichnung), `georef.ts`, `import.ts`, `presentation.ts` |

## Neuen Befehl anlegen

1. Test zuerst: `cmds/<name>.test.ts` (Muster: `cmds/line.test.ts`).
2. Modul `cmds/<name>.ts` mit einem `Command`. Was Geometrie oder neue Elemente rechnet, gehört in den Kern
   (`cmd_create.rs` oder passendes `cmd_*.rs`); der Befehl ruft ihn über `createCore.ts`.
3. In `registry.ts` importieren und in `COMMANDS` eintragen, Kürzel ergänzen.
4. Aufforderungen und Optionen nur über `t()`, Schlüssel in `src/i18n/de.ts` und `en.ts`.
5. `src/commands/hostile.test.ts` füttert jeden registrierten Befehl mit Unsinn; er muss grün bleiben.
