// @effect-diagnostics nodeBuiltinImport:off - Regression coverage scans all app-shell surfaces.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { APP_SHELL_VIEWPORT_HEIGHT_CLASS, AppViewportInset } from "./AppViewportInset";
import { SidebarProvider } from "./ui/sidebar";

const APP_VIEWPORT_SURFACES = [
  "../routes/_chat.$environmentId.$threadId.tsx",
  "../routes/_chat.draft.$draftId.tsx",
  "../routes/_chat.index.tsx",
  "../routes/_chat.pull-requests.tsx",
  "../routes/settings.tsx",
  "./NoActiveThreadState.tsx",
  "./settings/ProjectSettingsPanel.tsx",
  "./usage/UsagePage.tsx",
] as const;

describe("app viewport height contract", () => {
  it("renders one stable viewport owner with inherited nested height", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider className={APP_SHELL_VIEWPORT_HEIGHT_CLASS}>
        <AppViewportInset data-testid="viewport-content" />
      </SidebarProvider>,
    );

    expect(html).toContain("h-svh!");
    expect(html.indexOf("h-svh!")).toBeLessThan(html.indexOf("h-full"));
    expect(html).toContain("h-full");
    expect(html).toContain("min-h-0");
    expect(html).toContain("overflow-hidden");
    expect(html.match(/h-svh!/g)).toHaveLength(1);
    expect(html).not.toContain("h-dvh");
    expect(html).not.toMatch(/(?:sm|md|lg|xl|2xl):h-(?:s|d)vh/);
  });

  it("does not switch a wide Android landscape viewport back to dynamic height", () => {
    const responsiveClasses = APP_SHELL_VIEWPORT_HEIGHT_CLASS.split(" ").filter((className) =>
      className.includes(":"),
    );

    expect(responsiveClasses).toEqual([]);
    expect(APP_SHELL_VIEWPORT_HEIGHT_CLASS).toContain("h-svh!");
    expect(APP_SHELL_VIEWPORT_HEIGHT_CLASS).not.toContain("dvh");
  });

  it("keeps every app-shell route out of nested viewport sizing", () => {
    for (const relativePath of APP_VIEWPORT_SURFACES) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");

      expect(source, relativePath).toContain("<AppViewportInset");
      expect(source, relativePath).not.toMatch(/<SidebarInset[^>]*\bh-(?:s|d)vh\b/);
      expect(source, relativePath).not.toMatch(/<AppViewportInset[^>]*\bh-(?:s|d)vh\b/);
    }
  });
});
