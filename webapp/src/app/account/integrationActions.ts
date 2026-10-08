"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/currentUser";
import { writeBlock } from "@/lib/workspaceAccess";
import { createIntegration, deleteIntegration, rotateWebhookSecret, sendTestDelivery, setIntegrationEnabled, type IntegrationKind } from "@/lib/integrations";
import { formText } from "@/lib/formData";

export type IntegrationResult = { ok: true; message?: string; secret?: string } | { ok: false; error: string };


export async function createIntegrationAction(formData: FormData): Promise<IntegrationResult> {
  const session = await requireSession();
  const blocked = await writeBlock(session.workspaceId);
  if (blocked) return { ok: false, error: blocked };
  const kind = formText(formData, "kind") as IntegrationKind;
  const result = await createIntegration(session, {
    kind,
    name: formText(formData, "name"),
    url: formText(formData, "url"),
    includeTranscript: formData.get("includeTranscript") === "on",
    slackWebhookUrl: formText(formData, "slackWebhookUrl"),
    notionToken: formText(formData, "notionToken"),
    notionPage: formText(formData, "notionPage"),
  });
  if (!result.ok) return result;
  revalidatePath("/account");
  return { ok: true, ...(result.secret ? { secret: result.secret } : {}), message: "Added. Send a test to check the connection." };
}

export async function toggleIntegrationAction(formData: FormData): Promise<IntegrationResult> {
  const session = await requireSession();
  const result = await setIntegrationEnabled(session, formText(formData, "id"), formData.get("enabled") === "1");
  if (!result.ok) return result;
  revalidatePath("/account");
  return { ok: true };
}

export async function deleteIntegrationAction(formData: FormData): Promise<IntegrationResult> {
  const session = await requireSession();
  const result = await deleteIntegration(session, formText(formData, "id"));
  if (!result.ok) return result;
  revalidatePath("/account");
  return { ok: true, message: "Removed." };
}

export async function testIntegrationAction(formData: FormData): Promise<IntegrationResult> {
  const session = await requireSession();
  const result = await sendTestDelivery(session, formText(formData, "id"));
  revalidatePath("/account");
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function rotateSecretAction(formData: FormData): Promise<IntegrationResult> {
  const session = await requireSession();
  const blocked = await writeBlock(session.workspaceId);
  if (blocked) return { ok: false, error: blocked };
  const result = await rotateWebhookSecret(session, formText(formData, "id"));
  if (!result.ok) return result;
  revalidatePath("/account");
  return { ok: true, secret: result.secret, message: "New secret created. The old one no longer works." };
}
