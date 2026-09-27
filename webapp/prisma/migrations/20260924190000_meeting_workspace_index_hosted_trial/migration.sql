-- Workspace-scoped meeting lists filter by workspaceId and order by startedAt.
CREATE INDEX "Meeting_workspaceId_startedAt_idx" ON "Meeting"("workspaceId", "startedAt");

-- Hosted workspaces created before the free trial existed would otherwise have
-- no plan at all. Give each one the no-card trial allowance (3 meetings). The
-- self-hosted default workspace is excluded; a workspace that already has any
-- subscription row is left untouched.
INSERT INTO "WorkspaceSubscription" ("id", "workspaceId", "plan", "status", "updatedAt")
SELECT gen_random_uuid()::text, w."id", 'hosted_trial', 'trialing', CURRENT_TIMESTAMP
FROM "Workspace" w
WHERE w."isDefault" = false
  AND NOT EXISTS (SELECT 1 FROM "WorkspaceSubscription" s WHERE s."workspaceId" = w."id");
