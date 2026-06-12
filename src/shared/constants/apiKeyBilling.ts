export const PREPAID_TOKEN_PACKAGES = [
  100_000_000, 200_000_000, 300_000_000, 500_000_000, 1_000_000_000, 1_500_000_000, 2_000_000_000,
] as const;

export type ApiKeyBillingMode = "system" | "prepaid";

export function isPrepaidTokenPackage(value: number | null | undefined): boolean {
  return PREPAID_TOKEN_PACKAGES.includes(value as (typeof PREPAID_TOKEN_PACKAGES)[number]);
}
