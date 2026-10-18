// Ties a sign-in page error (a code from the URL) to the fields it is about,
// so assistive tech hears the message on the right field and the cursor lands
// on the first thing to fix.

export const FORM_ERROR_ID = "form-error";

export type FieldRole = "setup" | "email" | "password" | "confirm" | "workspace" | "consent";

const FIELDS_FOR_ERROR: Record<string, FieldRole[]> = {
  invalid: ["email", "password"],
  "1": ["email", "password"],
  unverified: ["email"],
  "email-invalid": ["email"],
  "email-taken": ["email"],
  "password-mismatch": ["password", "confirm"],
  "weak-password": ["password"],
  "workspace-name": ["workspace"],
  "consent-required": ["consent"],
  bootstrap: ["setup"],
};

export function invalidRoles(error: string | undefined): FieldRole[] {
  if (!error || !Object.hasOwn(FIELDS_FOR_ERROR, error)) return [];
  return FIELDS_FOR_ERROR[error]!;
}

export interface FieldA11y {
  "aria-invalid"?: true;
  "aria-describedby"?: string;
  autoFocus?: boolean;
}

/**
 * Returns a per-form helper. `order` lists the form's fields top to bottom;
 * the first invalid one takes autofocus, otherwise the field the form asked
 * to focus by default keeps it. `hint` ids (like the password hint) are kept
 * alongside the error.
 */
export function formFields(error: string | undefined, order: FieldRole[]) {
  const invalid = new Set(invalidRoles(error).filter((role) => order.includes(role)));
  const first = order.find((role) => invalid.has(role));
  return (role: FieldRole, options: { hint?: string; autoFocus?: boolean } = {}): FieldA11y => {
    const isInvalid = invalid.has(role);
    const describedBy = [isInvalid ? FORM_ERROR_ID : null, options.hint ?? null].filter(Boolean).join(" ");
    const props: FieldA11y = {};
    if (isInvalid) props["aria-invalid"] = true;
    if (describedBy) props["aria-describedby"] = describedBy;
    const focus = first ? first === role : options.autoFocus === true;
    if (focus) props.autoFocus = true;
    return props;
  };
}
