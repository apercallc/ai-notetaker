"use server";

import { randomBytes } from "node:crypto";
import { requireSession } from "@/lib/currentUser";
import { hashPassword } from "@/lib/passwords";
import { addWorkspaceMember } from "@/lib/workspaces";
import { revalidatePath } from "next/cache";
import { ForbiddenError } from "./errors";

function generateTemporaryPassword(): string {
  return randomBytes(12).toString("base64url"); // 16 chars, URL-safe, easy to read aloud/copy
}

export async function addMember(formData: FormData): Promise<{ email: string; temporaryPassword: string }> {
  const session = await requireSession();
  if (session.role !== "owner") {
    throw new ForbiddenError("Only the workspace owner can add members.");
  }

  const email = String(formData.get("email") ?? "").trim();
  if (!email) throw new Error("email is required");

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  await addWorkspaceMember(session.workspaceId, email, passwordHash);

  revalidatePath("/team");
  return { email, temporaryPassword };
}
