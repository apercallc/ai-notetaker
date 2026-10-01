export const ACCOUNT_TABS = [
  { id: "security", label: "Security" },
  { id: "integrations", label: "Integrations" },
  { id: "data", label: "Data" },
  { id: "danger", label: "Danger zone" },
] as const;

export type AccountTabId = (typeof ACCOUNT_TABS)[number]["id"];

/**
 * Which settings section to show. An explicit, valid `tab` wins; otherwise the
 * query params other flows redirect with pick the section that explains them.
 */
export function resolveAccountTab(params: { tab?: string; required?: string; google?: string; googleError?: string }): AccountTabId {
  const explicit = ACCOUNT_TABS.find((tab) => tab.id === params.tab);
  if (explicit) return explicit.id;
  // A forced password change always lands where the password form lives.
  if (params.required === "1") return "security";
  if (params.google || params.googleError) return "integrations";
  return "security";
}
