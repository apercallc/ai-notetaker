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
  if (state.status === "complete") return <span className="badge badge-ready">Ready</span>;
  return (
    <span className="badge badge-failed" title={state.errorMessage ?? undefined}>
      Failed — {failureReason(state.errorMessage)}
    </span>
  );
}
