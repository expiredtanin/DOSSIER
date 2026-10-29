import { describe, expect, it } from "vitest";
import { fontNameOf } from "./dxfCadParts";

describe("fontNameOf", () => {
  it("erste echte Familie, ohne Anführungszeichen; generische/Variablen übersprungen", () => {
    expect(fontNameOf('"Helvetica Neue", Arial, sans-serif')).toBe("Helvetica Neue");
    expect(fontNameOf("var(--font-ui, sans-serif)")).toBeNull();
    expect(fontNameOf("sans-serif, Arial")).toBe("Arial");
    expect(fontNameOf("'Source Sans 3'")).toBe("Source Sans 3");
    expect(fontNameOf(undefined)).toBeNull();
    expect(fontNameOf("")).toBeNull();
  });
});
