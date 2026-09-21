"use client";

import { deleteMeetingAction } from "./actions";
import { useFormStatus } from "react-dom";

// Deleting a meeting is permanent and this app has no trash/undo (see
// webapp/CLAUDE.md — "the user owns their own deletion decisions"). A
// single unconfirmed click on a destructive action is a real risk for what
// is otherwise the permanent archive of someone's meeting notes, so this
// gets one confirmation step even though nothing else in this app does.
export function DeleteButton({ meetingId, meetingTitle }: { meetingId: string; meetingTitle: string }) {
  return (
    <form
      action={deleteMeetingAction}
      onSubmit={(e) => {
        if (!confirm(`Delete "${meetingTitle}"? This can't be undone.`)) {
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
      {pending ? "Deleting…" : "Delete meeting"}
    </button>
  );
}
