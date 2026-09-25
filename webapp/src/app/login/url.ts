import { safeNextPath } from "@/lib/navigation";

export type LoginTab = "signin" | "signup" | "forgot" | "reset" | "verify" | "invite";

export interface LoginUrlParams {
  tab?: LoginTab;
  error?: string;
  notice?: string;
  next?: string;
  token?: string;
  email?: string;
  retry?: number;
  problem?: string;
}

/** Builds /login URLs; `next` is re-validated and always keeps its query string. */
export function loginUrl(params: LoginUrlParams = {}): string {
  const search = new URLSearchParams();
  if (params.tab && params.tab !== "signin") search.set("tab", params.tab);
  if (params.error) search.set("error", params.error);
  if (params.notice) search.set("notice", params.notice);
  if (params.next) {
    const safe = safeNextPath(params.next);
    if (safe !== "/meetings") search.set("next", safe);
  }
  if (params.token) search.set("token", params.token);
  if (params.email) search.set("email", params.email);
  if (params.retry !== undefined) search.set("retry", String(params.retry));
  if (params.problem) search.set("problem", params.problem);
  const query = search.toString();
  return query ? `/login?${query}` : "/login";
}
