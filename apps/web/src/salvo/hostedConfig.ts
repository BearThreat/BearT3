import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { isElectron } from "../env";

export function hasExplicitSalvoHostedConfig(): boolean {
  return import.meta.env.VITE_SALVO_HOSTED?.trim().toLowerCase() === "true";
}

/** Salvo hosting is opt-in and requires the existing managed Clerk setup. */
export function isSalvoHostedExperience(): boolean {
  return !isElectron && hasExplicitSalvoHostedConfig() && hasCloudPublicConfig();
}
