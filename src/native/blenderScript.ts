// Text des Blender-Skripts `scripts/blender/render_dossier.py` ([211]), vom Bundler eingebettet: die App schreibt ihn
// zusammen mit dem Paket in den Arbeitsordner, so braucht sie keinen Pfad zu Dateien neben der Anwendung.

import script from "../../scripts/blender/render_dossier.py?raw";

export const RENDER_SCRIPT: string = script;
