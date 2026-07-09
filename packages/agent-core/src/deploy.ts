import { cloudflareProvider } from "./cloudflare";

/**
 * The deploy-provider seam. Sharing a prototype online is "build the workspace
 * and put it at a stable URL" — an operation every host supports. This module
 * defines that contract once (DeployProvider) and keeps a registry of
 * implementations, so adding Netlify / Vercel / a custom host later is a single
 * new file: implement the interface, register it, done. Nothing else in the
 * deploy flow or UI changes.
 *
 * Cloudflare Pages is the first (and default) provider — see ./cloudflare.
 */

export type DeployResult =
  | { url: string; pending?: boolean }
  | { error: string; needsLogin?: boolean; notInstalled?: boolean };

export interface DeployProvider {
  /** Stable id used in config / the HEMIUNU_DEPLOY_PROVIDER env var (e.g. "cloudflare"). */
  id: string;
  /** Human label for status readouts (e.g. "Cloudflare Pages"). */
  label: string;
  /** Whether credentials for this provider are present. */
  isConfigured(): boolean;
  /** One-line guidance shown when it isn't configured (how to connect). */
  connectHint(): string;
  /**
   * Build `dir` and publish it to a stable, shareable URL for `repo`. The same
   * repo always maps to the same URL (updates in place). prod is the default —
   * a preview is opt-in and provider-specific.
   */
  deploy(dir: string, opts: { repo: string; prod?: boolean }): Promise<DeployResult>;
}

/** Every known provider, keyed by id. New providers register here. */
const PROVIDERS: Record<string, DeployProvider> = {
  [cloudflareProvider.id]: cloudflareProvider,
};

/** All registered providers (for status / a future picker). */
export function listDeployProviders(): DeployProvider[] {
  return Object.values(PROVIDERS);
}

/** The active provider's id — HEMIUNU_DEPLOY_PROVIDER, defaulting to Cloudflare. */
export function activeProviderId(): string {
  return process.env.HEMIUNU_DEPLOY_PROVIDER?.trim() || cloudflareProvider.id;
}

/** The provider prototypes deploy to, or undefined if the id is unknown. */
export function activeProvider(): DeployProvider | undefined {
  return PROVIDERS[activeProviderId()];
}
