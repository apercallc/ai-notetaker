export default function Loading() {
  return (
    <div className="container loading-state" aria-live="polite" aria-busy="true">
      <p className="muted-copy">Loading meeting…</p>
    </div>
  );
}