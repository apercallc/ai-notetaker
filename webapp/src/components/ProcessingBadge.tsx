import type { ProcessingState } from "@/lib/meetings";

const MAX_REASON = 120;

/** Provider errors can be long and technical; keep the badge to one line. */
export function failureReason(message: string | null): string {
  const flat = (message ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "processing didn't finish";
  return flat.length > MAX_REASON ? `${flat.slice(0, MAX_REASON - 1)}…` : flat;
}

const STAGE_LABELS: Record<string, string> = {
  decoding: "Reading audio…",
  transcribing: "Transcribing…",
  summarizing: "Summarizing…",
};

export function ProcessingBadge({ state }: { state: ProcessingState }) {
  if (state.status === "processing") {
    return (
      <span className="badge badge-processing">
        <span className="spinner" aria-hidden="true" />
        {(state.stage && STAGE_LABELS[state.stage]) || "Processing…"}
      </span>
    );
  }
  // Finished notes are the normal case; a "Ready" pill on every row is noise.
  if (state.status === "complete") return null;
  // The badge stays short; the (possibly technical) reason is in the tooltip
  // and in the note page's callout.
  return (
    <span className="badge badge-failed" title={failureReason(state.errorMessage)}>
      Failed — couldn&apos;t finish notes
    </span>
  );
}
