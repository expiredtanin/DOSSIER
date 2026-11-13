#!/usr/bin/env bash
# install-linux-commands.sh — legt die Befehle `dossier` (App starten) und `update-dossier` (neusten Stand holen,
# bauen, aufräumen) in ~/.local/bin an. Unabhängig von der Shell (bash, zsh, fish). Einmal ausführen:
#
#   ./scripts/install-linux-commands.sh
#
# Danach überall: `dossier` startet Dossier, `update-dossier` aktualisiert (Optionen wie scripts/update-linux.sh,
# z. B. `update-dossier --start`). Entfernen: rm ~/.local/bin/dossier ~/.local/bin/update-dossier

set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
bin="${XDG_BIN_HOME:-$HOME/.local/bin}"
mkdir -p "$bin"

cat >"$bin/dossier" <<EOF
#!/usr/bin/env bash
# Startet Dossier aus $repo (angelegt von scripts/install-linux-commands.sh).
cd "$repo" && exec npm run electron -- "\$@"
EOF

cat >"$bin/update-dossier" <<EOF
#!/usr/bin/env bash
# Aktualisiert Dossier in $repo (angelegt von scripts/install-linux-commands.sh).
exec "$repo/scripts/update-linux.sh" "\$@"
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
