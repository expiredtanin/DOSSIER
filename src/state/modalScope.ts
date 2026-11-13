// [249] Gehört das Ereignisziel zu einem offenen modalen Dialog (`aria-modal="true"`)? Dann dürfen die App-Kürzel
// im Hintergrund (Entf, T, W/A/S/D, Auswahl-Esc …) nicht reagieren: die Taste gehört dem Dialog.

export function isInModalDialog(target: EventTarget | Element | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && typeof el.closest === "function" && el.closest('[aria-modal="true"]') !== null;
}
