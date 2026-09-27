/**
 * Asking Chrome for the microphone. Chrome ties the permission to the
 * extension's origin and cannot show its prompt inside the hidden offscreen
 * capture page, so it is requested on a normal extension page (onboarding, or
 * the standalone microphone tab) in response to a click, and stays granted.
 */
export type MicOutcome = "granted" | "blocked" | "no-device";

export async function requestMicrophone(): Promise<MicOutcome> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return "granted";
  } catch (error) {
    return error instanceof DOMException && error.name === "NotFoundError" ? "no-device" : "blocked";
  }
}

/** True when Chrome already remembers a grant, so a returning user is not asked twice. */
export async function microphoneAlreadyAllowed(): Promise<boolean> {
  try {
    if (!navigator.permissions?.query) return false;
    return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state === "granted";
  } catch {
    return false;
  }
}
