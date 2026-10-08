---
title: "Grundgedanke"
linkTitle: "Grundgedanke"
weight: 1
---

Es gibt **ein semantisches Modell** als einzige Wahrheit. Jede Ansicht — 3D,
Grundriss, Schnitt, Ansicht, PDF — wird daraus **abgeleitet**. Darstellung
(Detailgrad, Linienstärken, Schraffuren) wird erst beim Rendern angewandt, nie
in die Geometrie eingebacken. Wer eine Wand verschiebt, verschiebt sie überall.

Konkret heisst das auch: Der Grundriss entsteht nicht aus einem zerschnittenen
3D-Mesh, sondern **analytisch aus den Bauteil-Parametern** — Wandachsen und
Dicken werden zu Linien, Öffnungen zu Lücken mit Symbol. Der PDF-Export ist
derselbe Plan, nur mit echten mm-Stiftstärken statt Bildschirm-Hairlines.
Schnitte und Ansichten laufen über eine eigene, analytische Rust-Pipeline
(kein Hidden-Line-Removal nötig) und sind im 3D-Viewport live verdrahtet,
nicht nur ein Spike.

## Herkunft

DOSSIER ist die eigenständige Neuimplementierung des gleichnamigen
Rhino-Plugins: dieselbe Denkweise — Geschosse, Kategorie-Ebenen, mehrschichtige
Bauteile, Prioritäts-Verschneidung — jetzt mit eigenem Datenmodell und eigener
Rendering-Engine (Rust/WASM/WebGPU, intern „Nordstern" genannt) statt
Rhino-Aufsatz.
