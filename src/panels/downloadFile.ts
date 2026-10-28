// Stösst den Download einer Datei an (reiner Client, Blob-URL).

export function downloadFile(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** CSV mit BOM, damit Excel UTF-8 (Umlaute/„m²") korrekt liest. */
export function downloadCsv(fileName: string, content: string): void {
  downloadFile(fileName, new Blob(["﻿" + content], { type: "text/csv;charset=utf-8;" }));
}
