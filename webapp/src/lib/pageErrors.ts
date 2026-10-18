// Pages that show an error from a redirect read a short code from the query
// string and look up their own copy. Free text is never carried in the URL:
// anyone can craft a link, and words rendered inside role="alert" on our own
// domain would read as the product speaking.

const GENERIC = "Something went wrong. Try again.";

const MEETING_ERROR_TEXT: Record<string, string> = {
  "delete-forbidden": "Only the person who wrote this note, or a workspace owner, can move it to Trash.",
};

/** Copy for `/meetings/[id]?error=<code>`; unknown codes get a generic line. */
export function meetingErrorText(code: string | undefined): string | null {
  if (!code) return null;
  // Own keys only: "constructor" and friends must not resolve through the prototype.
  return Object.hasOwn(MEETING_ERROR_TEXT, code) ? MEETING_ERROR_TEXT[code]! : GENERIC;
}

export type GoogleErrorCode =
  | "not-configured"
  | "unavailable"
  | "unverified"
  | "denied"
  | "no-code"
  | "not-accepted"
  | "reconnect"
  | "unreachable"
  | "save-failed";

const GOOGLE_ERROR_TEXT: Record<GoogleErrorCode, string> = {
  "not-configured": "Google isn't set up on this deployment yet. Ask an administrator to configure it.",
  unavailable: "Google integration is unavailable. Try again later.",
  unverified: "Google authorization could not be verified. Try connecting again.",
  denied: "Google authorization was cancelled or denied.",
  "no-code": "Google didn't return an authorization code. Try connecting again.",
  "not-accepted": "Google didn't accept the authorization. Try connecting again.",
  reconnect: "Google access was removed or expired. Connect Google again.",
  unreachable: "Google couldn't be reached. Try again.",
  "save-failed": "The Google connection couldn't be saved. Try again.",
};

/** Copy for `/account?googleError=<code>`; unknown codes get a generic line. */
export function googleErrorText(code: string | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(GOOGLE_ERROR_TEXT, code) ? GOOGLE_ERROR_TEXT[code as GoogleErrorCode] : "Google couldn't be connected. Try again.";
}

/** Maps a GoogleIntegrationError's HTTP-ish status to the code the account page understands. */
export function googleErrorCodeForStatus(status: number | undefined): GoogleErrorCode {
  if (status === 503) return "not-configured";
  if (status === 409) return "reconnect";
  if (status === 400) return "not-accepted";
  return "unreachable";
}
