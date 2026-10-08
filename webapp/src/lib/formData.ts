/** Reads a text field from a submitted form; a missing field reads as an empty string. */
export function formText(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}
