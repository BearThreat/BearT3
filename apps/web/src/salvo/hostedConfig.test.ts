import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: vi.fn(() => true) }));
vi.mock("../env", () => ({ isElectron: false }));

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { hasExplicitSalvoHostedConfig, isSalvoHostedExperience } from "./hostedConfig";

describe("Salvo hosted configuration", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(hasCloudPublicConfig).mockReturnValue(true);
  });

  it("stays disabled unless the deployment explicitly opts in", () => {
    expect(hasExplicitSalvoHostedConfig()).toBe(false);
    expect(isSalvoHostedExperience()).toBe(false);
  });

  it("activates only with managed Clerk configuration", () => {
    vi.stubEnv("VITE_SALVO_HOSTED", "true");
    expect(isSalvoHostedExperience()).toBe(true);

    vi.mocked(hasCloudPublicConfig).mockReturnValue(false);
    expect(isSalvoHostedExperience()).toBe(false);
  });

  it("does not accept similar truthy strings", () => {
    vi.stubEnv("VITE_SALVO_HOSTED", "1");
    expect(isSalvoHostedExperience()).toBe(false);
  });
});
