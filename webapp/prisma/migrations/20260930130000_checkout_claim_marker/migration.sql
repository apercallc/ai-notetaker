-- Checkout used to claim its mutex by overwriting "status" with
-- "checkout_pending", which destroyed a trial's remaining meetings and left a
-- canceled customer unable to regain access after resubscribing. The claim now
-- has its own column and "status" always reflects the real subscription state.
ALTER TABLE "WorkspaceSubscription" ADD COLUMN "checkoutClaimedAt" TIMESTAMP(3);

UPDATE "WorkspaceSubscription"
SET "status" = CASE WHEN "plan" = 'hosted_trial' THEN 'trialing' ELSE 'inactive' END
WHERE "status" = 'checkout_pending';
