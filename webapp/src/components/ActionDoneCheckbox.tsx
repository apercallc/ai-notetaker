"use client";

// Checking the box submits its enclosing form immediately, matching the
// extension's instant-autosave behavior for the same "mark done" action
// (extension/src/meeting/meeting.ts, extension/src/actions/actions.ts).
// Without this, the checkbox visibly toggles but nothing persists until a
// separate "Save" click, and a user who checks the box and navigates away
// silently loses the change (found in design review).
export function ActionDoneCheckbox({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="action-checkbox">
      <span className="sr-only">{label}</span>
      <input
        type="checkbox"
        name={name}
        value="1"
        defaultChecked={defaultChecked}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      />
    </label>
  );
}
