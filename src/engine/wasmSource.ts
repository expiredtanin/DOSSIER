// Woher die WASM-Module ihre Bytes bekommen. Im Browser/Tauri: Standard (wasm-bindgen lädt die
// `_bg.wasm` per URL). Headless (`dossier-cli`, Node): ein Provider liefert die Bytes aus Dateien.
// Jede Lade-Stelle (`engine3d.ts`, `truckSolid.ts`) ruft {@link wasmInitArg}.

type Provider = (name: string) => Promise<BufferSource>;
let provider: Provider | null = null;

/** Setzt den Byte-Provider (`name` = "render3d" | "trucksolid" | …). */
export function setWasmBytesProvider(p: Provider | null): void {
  provider = p;
}

/** Argument für `mod.default(...)` — `undefined` = Standard-Laden per URL. */
export async function wasmInitArg(name: string): Promise<{ module_or_path: BufferSource } | undefined> {
  return provider ? { module_or_path: await provider(name) } : undefined;
}
