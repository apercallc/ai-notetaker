"use client";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="container error-state" role="alert">
      <h1>Something went wrong</h1>
      <p className="muted-copy">Your notes are safe. Try loading this page again.</p>
      <button type="button" onClick={() => reset()}>
        Try again
      </button>
    </main>
  );
}
