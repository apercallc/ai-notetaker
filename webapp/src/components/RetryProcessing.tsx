"use client";

import { useState, useTransition } from "react";
import { retryProcessingAction } from "@/app/meetings/[id]/actions";

export function RetryProcessing({ meetingId, className = "button button-secondary button-small" }: { meetingId: string; className?: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function retry() {
    setError(null);
    const formData = new FormData();
    formData.set("meetingId", meetingId);
    startTransition(async () => {
      const result = await retryProcessingAction(formData);
      if (result.status === "error") setError(result.message);
    });
  }

  return (
    <span className="inline-action">
      <button type="button" className={className} onClick={retry} disabled={pending} aria-busy={pending}>
        {pending ? "Retrying…" : "Retry"}
      </button>
      {error && <span className="error-text" role="alert">{error}</span>}
    </span>
  );
}
