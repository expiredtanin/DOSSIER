#!/bin/sh
# Startet Dossier im Flatpak über zypak (Chromium-Sandbox innerhalb von Flatpak).
exec zypak-wrapper /app/lib/dossier/dossier "$@"
