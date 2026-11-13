#!/usr/bin/env bash
# install-linux-commands.sh — legt die Befehle `dossier` (App starten) und `update-dossier` (neusten Stand holen,
# bauen, aufräumen) in ~/.local/bin an. Unabhängig von der Shell (bash, zsh, fish). Einmal ausführen:
#
#   ./scripts/install-linux-commands.sh            Entwicklung: `dossier` startet aus dem Quellcode (npm run electron)
#   ./scripts/install-linux-commands.sh --tester   Test-Rechner: `update-dossier` baut ein AppImage und löscht danach
#                                                  alles zum Bauen Nötige; `dossier` startet das AppImage
#
# Danach überall: `dossier` startet Dossier, `update-dossier` aktualisiert (Optionen wie scripts/update-linux.sh,
# z. B. `update-dossier --start`). Entfernen: rm ~/.local/bin/dossier ~/.local/bin/update-dossier

set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
mode=""
[ "${1:-}" = "--tester" ] && mode="--tester"
bin="${XDG_BIN_HOME:-$HOME/.local/bin}"
mkdir -p "$bin"

cat >"$bin/dossier" <<EOF
#!/usr/bin/env bash
# Startet Dossier aus $repo (angelegt von scripts/install-linux-commands.sh).
cd "$repo"
# Ohne node_modules (Test-Rechner, update-dossier --tester) das zuletzt gebaute AppImage, sonst aus dem Quellcode.
app=\$(ls -1t release/Dossier-*.AppImage 2>/dev/null | head -1)
# Wayland: nativ (über XWayland schwarzer Rand in runden Fensterecken); GPU-Modus „minimal“ setzt electron-main.cjs.
oz=\${DOSSIER_OZONE:-}; if [ -z "\$oz" ] && { [ -n "\${WAYLAND_DISPLAY:-}" ] || [ "\${XDG_SESSION_TYPE:-}" = wayland ]; }; then oz=wayland; fi
if [ ! -d node_modules ] && [ -n "\$app" ]; then
  # Warnung, wenn das AppImage älter ist als der Checkout (update-dossier nicht durchgelaufen)
  [ "\$(stat -c %Y "\$app")" -lt "\$(git log -1 --format=%ct 2>/dev/null || echo 0)" ] && echo "[dossier] Hinweis: \$app ist älter als der Checkout — update-dossier erneut laufen lassen." >&2
  exec "\$app" \${oz:+--ozone-platform=\$oz} "\$@"; fi
exec npm run electron -- "\$@"
EOF

cat >"$bin/update-dossier" <<EOF
#!/usr/bin/env bash
# Aktualisiert Dossier in $repo (angelegt von scripts/install-linux-commands.sh).
exec "$repo/scripts/update-linux.sh" $mode "\$@"
EOF

chmod +x "$bin/dossier" "$bin/update-dossier"
echo "Angelegt: $bin/dossier und $bin/update-dossier (Checkout: $repo)"
case ":$PATH:" in
  *":$bin:"*) ;;
  *)
    echo
    echo "Hinweis: $bin ist noch nicht im PATH. Einmal ergänzen:"
    echo "  bash/zsh:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.\${SHELL##*/}rc"
    echo "  fish:      fish_add_path ~/.local/bin"
    echo "Danach ein neues Terminal öffnen."
    ;;
esac
