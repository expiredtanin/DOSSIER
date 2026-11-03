// [117] Die CSP-Quelle (scripts/csp.cjs) deckt die netFetch-Hosts ab und steht wörtlich in tauri.conf.json.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ALLOWED_HOSTS } from "./net";

const { buildCsp, NET_HOSTS } = createRequire(import.meta.url)("../../scripts/csp.cjs") as {
  buildCsp: () => string;
  NET_HOSTS: string[];
};

describe("CSP", () => {
  it("connect-src enthält genau die Remote-Hosts von ALLOWED_HOSTS", () => {
    const remote = ALLOWED_HOSTS.filter((h) => h !== "localhost" && h !== "127.0.0.1");
    expect([...NET_HOSTS].sort()).toEqual([...remote].sort());
    const connect = buildCsp().split("; ").find((d) => d.startsWith("connect-src "))!;
    for (const h of remote) expect(connect).toContain(`https://${h}`);
  });
  it("tauri.conf.json trägt dieselbe Richtlinie", () => {
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(conf.app.security.csp).toBe(buildCsp());
  });
  it("kein unsafe-eval, keine Inline-Skripte", () => {
    const script = buildCsp().split("; ").find((d) => d.startsWith("script-src "))!;
    expect(script).toBe("script-src 'self' 'wasm-unsafe-eval'");
  });
});
