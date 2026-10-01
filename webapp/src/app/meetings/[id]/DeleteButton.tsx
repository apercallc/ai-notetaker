"use client";

import { deleteMeetingAction } from "./actions";
import { useFormStatus } from "react-dom";

// Deleting moves the note to the Trash, where it stays for 30 days and can be
// restored. It still gets one confirmation step: the note disappears from the
// library immediately, and from the Trash for good after the window.
export function DeleteButton({ meetingId, meetingTitle }: { meetingId: string; meetingTitle: string }) {
  return (
    <form
      action={deleteMeetingAction}
      onSubmit={(e) => {
        if (!confirm(`Move "${meetingTitle}" to Trash? You can restore it for 30 days.`)) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="id" value={meetingId} />
      <DeleteSubmitButton />
    </form>
  );
}

function DeleteSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="button button-danger" disabled={pending} aria-busy={pending}>
      {pending ? "Moving…" : "Move to Trash"}
    </button>
  );
}
