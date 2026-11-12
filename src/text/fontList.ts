// Gebündelte Schriften (SIL Open Font License), die Textwerkzeug, Textstile und Raumstempel anbieten
// ([218] aus `ui/TopBar.tsx` hierher, damit auch die Objekteinstellungen sie ohne Umweg über die Oberleiste nutzen).
// Bezeichner englisch, Kommentare deutsch.

/**
 * Schriftauswahl der Text-Gruppe: 15 kuratierte, lokal gebuendelte
 * Open-Source-Schriften (SIL Open Font License, siehe `src/text/fonts.css`
 * und `public/fonts/<slug>/OFL.txt`). Bewusst KEINE Systemfonts mehr — die
 * Darstellung soll unabhaengig vom Betriebssystem und der PDF-Export
 * deterministisch sein. Ein spaeterer Einstellungen-Dialog kann weitere
 * Schriften nachladen; das hier ist die Standardliste.
 */
export const TEXT_FONTS: string[] = [
  "Inter",
  "Work Sans",
  "IBM Plex Sans",
  "IBM Plex Mono",
  "Source Sans 3",
  "Space Grotesk",
  "Manrope",
  "Outfit",
  "DM Sans",
  "Public Sans",
  "Karla",
  "Rubik",
  "Jost",
  "Archivo",
  "Source Serif 4",
];

