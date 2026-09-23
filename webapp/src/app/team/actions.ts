"use server";

import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/currentUser";
import { hashPassword } from "@/lib/passwords";
import { addWorkspaceMember } from "@/lib/workspaces";
import { revalidatePath } from "next/cache";

/**
 * Expected failures are returned, never thrown.
 *
 * Next.js replaces the message of anything thrown out of a Server Action in
 * a production build with a generic string plus a digest — so throwing
 * `ForbiddenError("Only the workspace owner can add members.")` reached the
 * user as "An unexpected response was received from the server", and a
 * duplicate email surfaced as the same unhelpful text. Anything a person can
 * actually act on has to come back as a value.
 */
export type AddMemberResult =
  | { ok: true; email: string; temporaryPassword: string }
  | { ok: false; error: string };

function generateTemporaryPassword(): string {
  return randomBytes(12).toString("base64url"); // 16 chars, URL-safe, easy to read aloud/copy
}

export async function addMember(formData: FormData): Promise<AddMemberResult> {
  const session = await requireSession();
  if (session.role !== "owner") {
    return { ok: false, error: "Only the workspace owner can add members." };
  }

  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    return { ok: false, error: "Enter an email address." };
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    await addWorkspaceMember(session.workspaceId, email, passwordHash);
  } catch (error) {
    // P2002 is the unique constraint on User.email.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, error: `${email} is already on this team.` };
    }
    console.error("adding a workspace member failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "Could not add that member. Try again." };
  }

  revalidatePath("/team");
  return { ok: true, email, temporaryPassword };
}
