// @effect-diagnostics nodeBuiltinImport:off - Regression coverage scans the composer source.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const composerSource = readFileSync(new URL("./ChatComposer.tsx", import.meta.url), "utf8");

describe("mobile web image controls", () => {
  it("keeps distinct camera and photo inputs on the existing image intake path", () => {
    expect(composerSource).toContain('accept="image/gif,image/jpeg,image/png,image/webp"');
    expect(composerSource).toMatch(/accept="image\/\*"[\s\S]*?capture="environment"/);
    expect(composerSource).toMatch(
      /const onComposerImageInputChange[\s\S]*?input\.value = "";[\s\S]*?void addComposerImages\(files\)/,
    );
    expect(composerSource.match(/onChange=\{onComposerImageInputChange\}/g)).toHaveLength(2);
  });

  it("exposes both controls in collapsed and expanded composer layouts", () => {
    expect(composerSource.match(/aria-label="Take a picture"/g)).toHaveLength(2);
    expect(composerSource.match(/aria-label="Add photos or screenshots"/g)).toHaveLength(2);
    expect(composerSource).toContain("openComposerCamera();");
    expect(composerSource).toContain("openComposerImagePicker();");
    expect(composerSource).toContain("onClick={openComposerCamera}");
    expect(composerSource).toContain("onClick={openComposerImagePicker}");
  });
});
