/** Dependency-free: the request proxy must not load the storage SDK for CSP. */
export function directUploadOrigin(): string | undefined {
  try {
    const url = new URL(process.env.MANAGED_OBJECT_UPLOAD_ORIGIN ?? "");
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url.origin : undefined;
  } catch { return undefined; }
}
