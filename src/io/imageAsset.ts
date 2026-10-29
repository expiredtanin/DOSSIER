// Bild-Datei → eingebettete Data-URL + natürliche Pixelgrösse — gemeinsame
// Grundlage für „Bild einfügen" (Drawing2D `{shape:"image"}`, auch auf einem
// Layout-Blatt). Reine Browser-API (FileReader +
// Image), kein Tauri-fs nötig — funktioniert identisch im Web-Preview.

export interface LoadedImageAsset {
  /** Data-URL (PNG/JPEG/…), direkt im Projekt einbettbar (kein externer Pfad). */
  src: string;
  naturalWidth: number;
  naturalHeight: number;
}

/** Liest eine Bilddatei als Data-URL + ermittelt ihre natürliche Pixelgrösse. */
export function readImageFile(file: File): Promise<LoadedImageAsset> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const src = String(reader.result);
      const img = new Image();
      img.onload = () =>
        resolve({ src, naturalWidth: img.naturalWidth || 1, naturalHeight: img.naturalHeight || 1 });
      img.onerror = () => resolve({ src, naturalWidth: 1, naturalHeight: 1 });
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

/** Default-Grösse (Modell-Meter) aus dem Pixel-Seitenverhältnis: feste Breite, Höhe folgt. */
export function defaultImageSizeM(
  naturalWidth: number,
  naturalHeight: number,
  widthM = 2,
): { widthM: number; heightM: number } {
  const ratio = naturalHeight / Math.max(1, naturalWidth);
  return { widthM, heightM: Math.max(0.05, widthM * ratio) };
}
