"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/currentUser";
import { writeBlock } from "@/lib/workspaceAccess";
import { createIntegration, deleteIntegration, rotateWebhookSecret, sendTestDelivery, setIntegrationEnabled, type IntegrationKind } from "@/lib/integrations";

export type IntegrationResult = { ok: true; message?: string; secret?: string } | { ok: false; error: string };

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "");

export async function createIntegrationAction(formData: FormData): Promise<IntegrationResult> {
  const session = await requireSession();
  const blocked = await writeBlock(session.workspaceId);
  if (blocked) return { ok: false, error: blocked };
  const kind = text(formData, "kind") as IntegrationKind;
  const result = await createIntegration(session, {
    kind,
    name: text(formData, "name"),
    url: text(formData, "url"),
    includeTranscript: formData.get("includeTranscript") === "on",
    slackWebhookUrl: text(formData, "slackWebhookUrl"),
    notionToken: text(formData, "notionToken"),
    notionPage: text(formData, "notionPage"),
  });
  if (!result.ok) return result;
  revalidatePath("/account");
  return { ok: true, ...(result.secret ? { secret: result.secret } : {}), message: "Added. Send a test to check the connection." };
}

export async function toggleIntegrationAction(formData: FormData): Promise<IntegrationResult> {
  const session = await requireSession();
  const result = await setIntegrationEnabled(session, text(formData, "id"), formData.get("enabled") === "1");
  if (!result.ok) return result;
  revalidatePath("/account");
  return { ok: true };
}

export async function deleteIntegrationAction(formData: FormData): Promise<IntegrationResult> {
  const session = await requireSession();
  const result = await deleteIntegration(session, text(formData, "id"));
  if (!result.ok) return result;
  revalidatePath("/account");
  return { ok: true, message: "Removed." };
}

export async function testIntegrationAction(formData: FormData): Promise<IntegrationResult> {
  const session = await requireSession();
  const result = await sendTestDelivery(session, text(formData, "id"));
  revalidatePath("/account");
  return result.ok ? { ok: true, message: result.message } : result;
}

export async function rotateSecretAction(formData: FormData): Promise<IntegrationResult> {
  const session = await requireSession();
  const blocked = await writeBlock(session.workspaceId);
  if (blocked) return { ok: false, error: blocked };
  const result = await rotateWebhookSecret(session, text(formData, "id"));
  if (!result.ok) return result;
  revalidatePath("/account");
  return { ok: true, secret: result.secret, message: "New secret created. The old one no longer works." };
}
