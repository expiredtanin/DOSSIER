// Vite-Import `…?raw` (Dateiinhalt als Text, z. B. das Blender-Skript `native/blenderScript.ts`); das Projekt bindet
// die vite/client-Typen nicht ein.
declare module "*?raw" {
  const content: string;
  export default content;
}

// [263] Vite `import.meta.glob` (Kurzanleitung-Bilder in `ui/QuickGuideDialog.tsx`), ohne die vite/client-Typen.
interface ImportMeta {
  glob(pattern: string, options?: { query?: string; import?: string; eager?: boolean }): Record<string, unknown>;
}
