-- Pending Stripe cancellation date, so the billing page can say when access ends.
ALTER TABLE "WorkspaceSubscription" ADD COLUMN "cancelsAt" TIMESTAMP(3);
