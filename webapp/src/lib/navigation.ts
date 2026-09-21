const LOCAL_ORIGIN = "http://ai-notetaker.invalid";

/** Keep post-login redirects inside this self-hosted app. */
export function safeNextPath(value: string | undefined): string {
  const candidate = value?.trim() ?? "";
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return "/meetings";

  try {
    const parsed = new URL(candidate, LOCAL_ORIGIN);
    // URL parsing treats backslashes as authority separators in the same way
    // browsers do, so this also rejects values such as `/\\\\evil.example`.
    if (parsed.origin !== LOCAL_ORIGIN) return "/meetings";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/meetings";
  }
}
