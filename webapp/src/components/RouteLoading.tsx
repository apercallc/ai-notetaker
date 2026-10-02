type LoadingVariant = "generic" | "library" | "meeting" | "actions";

/** Static, page-shaped fallback that keeps route transitions from collapsing to a one-line flash. */
export function RouteLoading({ label, variant = "generic" }: { label: string; variant?: LoadingVariant }) {
  const rows = variant === "meeting" ? 2 : variant === "actions" ? 4 : 5;
  return (
    <>
      <p className="sr-only" role="status">{label}</p>
      <div className="container route-loading" aria-busy="true">
        <div className={`route-loading-placeholder route-loading-${variant}`} aria-hidden="true">
          <span className="loading-bar loading-heading" />
          <span className="loading-bar loading-copy" />
          <section className="loading-panel">
            {Array.from({ length: rows }, (_, index) => (
              <div className="loading-row" key={index}>
                <span className="loading-bar loading-row-title" />
                <span className="loading-bar loading-row-copy" />
              </div>
            ))}
          </section>
        </div>
      </div>
    </>
  );
}
