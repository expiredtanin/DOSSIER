// Vite-Import `…?raw` (Dateiinhalt als Text, z. B. das Blender-Skript `native/blenderScript.ts`); das Projekt bindet
// die vite/client-Typen nicht ein.
declare module "*?raw" {
  const content: string;
  export default content;
}
