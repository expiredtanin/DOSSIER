---
title: "Konventionen"
linkTitle: "Konventionen"
weight: 6
---

- **Bezeichner im Code sind englisch**, an Vectorworks-Terminologie angelehnt
  (Design Layer, Component, Hatch, Wall Style). **UI-Texte sind deutsch**,
  immer über `t('key')` — keine hartcodierten Strings im JSX.
- **Einheiten:** intern alles in **Metern** (number). Anzeige via `formatM`.
- **Geometrie:** Wand-Normale `n = leftNormal(u) = (-u.y, u.x)`; bei
  CCW-Wicklung zeigt `+n` nach innen. Schichten werden aussen (−T/2) → innen
  (+T/2) gestapelt.
- **Zeichnungsnormen und Symbolik** durchgängig nach SIA (Schweiz), nicht DIN.

Verbindlich und vollständig in [CONVENTIONS.md](https://git.openbureau.ch/karim/DOSSIER-STANDALONE/raw/branch/master/CONVENTIONS.md).
