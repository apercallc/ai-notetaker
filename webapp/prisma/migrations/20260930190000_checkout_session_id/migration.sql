-- Remember the open Checkout Session so a retry can expire it instead of
-- locking the owner out for an hour.
ALTER TABLE "WorkspaceSubscription" ADD COLUMN "checkoutSessionId" TEXT;
