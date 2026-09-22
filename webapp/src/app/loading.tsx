export default function Loading() {
  return (
    <main className="container loading-state" aria-live="polite" aria-busy="true">
      <p className="muted-copy">Loading your meetings…</p>
    </main>
  );
}
