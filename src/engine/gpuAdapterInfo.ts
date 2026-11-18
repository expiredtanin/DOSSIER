// [290] Welcher WebGPU-Adapter zeichnet? Unter Linux/Electron (und im Browser) kann Chromium ohne Vulkan-Freigabe oder
// bei gesperrtem Treiber auf SwiftShader (Software, CPU) ausweichen — dann läuft das 3D auf dem Prozessor und der Rechner
// „schwitzt“. Einmal beim Start abgefragt, in die Konsole geschrieben und im Über-Dialog gezeigt.

export interface GpuAdapterSummary {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  /** Software-Adapter (SwiftShader, llvmpipe, Fallback): 3D auf der CPU. */
  software: boolean;
}

interface AdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  isFallbackAdapter?: boolean;
}

/** Software-Rasterer erkennen (Chromium meldet SwiftShader als vendor „google“, architecture „swiftshader“). */
export function isSoftwareAdapter(info: AdapterInfoLike, fallback = false): boolean {
  if (fallback || info.isFallbackAdapter) return true;
  const s = `${info.vendor ?? ""} ${info.architecture ?? ""} ${info.device ?? ""} ${info.description ?? ""}`.toLowerCase();
  return /swiftshader|llvmpipe|lavapipe|softpipe|software|microsoft basic render/.test(s);
}

export function summarizeAdapter(info: AdapterInfoLike, fallback = false): GpuAdapterSummary {
  return {
    vendor: info.vendor ?? "",
    architecture: info.architecture ?? "",
    device: info.device ?? "",
    description: info.description ?? "",
    software: isSoftwareAdapter(info, fallback),
  };
}

/** Kurzer Text wie „amd rdna-3 (AMD Radeon RX 7800 XT)“; leer, wenn der Browser nichts verrät. */
export function describeAdapter(a: GpuAdapterSummary): string {
  const head = [a.vendor, a.architecture].filter(Boolean).join(" ");
  const detail = a.description || a.device;
  return detail && detail !== head ? (head ? `${head} (${detail})` : detail) : head;
}

let cached: Promise<GpuAdapterSummary | null> | null = null;

/** Adapter der Seite (einmal abgefragt); `null` ohne WebGPU. */
export function gpuAdapterSummary(): Promise<GpuAdapterSummary | null> {
  if (cached) return cached;
  cached = (async () => {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: unknown): Promise<unknown> } }).gpu;
      if (!gpu) return null;
      const adapter = (await gpu.requestAdapter({ powerPreference: "high-performance" })) as
        | { info?: AdapterInfoLike; isFallbackAdapter?: boolean; requestAdapterInfo?: () => Promise<AdapterInfoLike> }
        | null;
      if (!adapter) return null;
      const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
      return summarizeAdapter(info, !!adapter.isFallbackAdapter);
    } catch {
      return null;
    }
  })();
  return cached;
}

/** Beim Start einmal in die Konsole (Electron gibt die Renderer-Konsole nicht aus; Über-Dialog zeigt es auch). */
export function logGpuAdapter(): void {
  void gpuAdapterSummary().then((a) => {
    if (!a) console.warn("[dossier] WebGPU: kein Adapter — 2D/3D über Ersatzwege");
    else if (a.software) console.warn(`[dossier] WebGPU-Adapter: ${describeAdapter(a)} — SOFTWARE (CPU), 3D belastet den Prozessor`);
    else console.info(`[dossier] WebGPU-Adapter: ${describeAdapter(a)}`);
  });
}
