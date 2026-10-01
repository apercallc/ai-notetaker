"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/currentUser";
import { updateLanguageSettings } from "@/lib/languageSettings";

export type LanguageSettingsResult = { ok: true; message: string } | { ok: false; error: string };

export async function updateLanguageSettingsAction(formData: FormData): Promise<LanguageSettingsResult> {
  const session = await requireSession();
  const result = await updateLanguageSettings(session, { vocabulary: String(formData.get("vocabulary") ?? ""), summaryLanguage: String(formData.get("summaryLanguage") ?? "") });
  if (!result.ok) return result;
  revalidatePath("/account");
  return { ok: true, message: result.terms === 0 ? "Saved." : `Saved ${result.terms} ${result.terms === 1 ? "term" : "terms"}.` };
}
