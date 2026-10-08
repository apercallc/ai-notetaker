# Refunds, cancellations and billing edge cases

Operator playbook for the managed service. The customer-facing policy is the
"Refunds and cancellations" section of the Terms page (`/terms`) and the
pricing FAQ; keep this file, those pages and the Stripe customer portal in
step. Plans: Pro (cloud sync) and Team (team sync), each billed monthly or
yearly through Stripe.

## Policy in one table

| Situation | What the customer gets | What you do |
| --- | --- | --- |
| New subscriber asks within 14 days of first payment (monthly or yearly), first time on the account | Full refund | Refund the charge **and** cancel the subscription immediately (see below) |
| Charged by mistake or twice, reported within 60 days | Refund of the erroneous charge | Refund that charge only; keep the subscription if the other charge is valid |
| Yearly plan renewed unintentionally, asked within 7 days of renewal | Full refund of the renewal | Refund and cancel immediately |
| Sync unavailable because of us for more than 72 hours in a row | Refund of the affected time (share of the paid period) | Partial refund, keep the subscription |
| Cancels mid-period, outside the cases above | No refund; plan runs to the end of the paid period and does not renew | Nothing. The portal cancels at period end |
| Cancels a yearly plan mid-year after 14 days | No refund of unused months | Nothing; explain that access continues to the end of the year |
| Deletes their account | Subscription cancelled immediately, no refund unless one of the cases above applies | The app cancels it (`cancelWorkspaceSubscription`) |
| Team owner cancels | Sync stops for every member at period end; notes stay read-only and exportable | Nothing |
| Switches plan or interval from Manage billing | Immediate change; unused time credited toward the new price | Nothing. Stripe prorates |
| Payment fails | 3 days of continued access (`PAYMENT_GRACE_MS`) while Stripe retries, then sync stops | Nothing. Paying the open invoice restores sync |
| Bank dispute on a valid charge | We may pause sync on that workspace until resolved; notes stay readable | See "Disputes" |

## Issuing a refund correctly

A refund alone does **not** end a subscription in Stripe. If you only refund,
the customer keeps sync and is charged again next period. For the full-refund
cases:

1. In Stripe, open the customer's subscription and choose **Cancel
   subscription**, then **Cancel immediately** with the **Refund** option
   (or refund the latest payment first and then cancel immediately).
2. Stripe sends `customer.subscription.deleted`. The webhook
   (`applyStripeEvent` in `webapp/src/lib/billing.ts`) sets the workspace to
   `canceled`, `plan` back to `local`, and sync access ends. Notes already in
   the account stay readable and exportable. Nothing is deleted.
3. For a partial (service credit) refund, refund the payment for the affected
   share and leave the subscription alone.

Refunds go back to the original payment method only and usually take 5 to 10
business days. Tax collected on the refunded amount is refunded with it. We do
not refund a customer's bank currency-conversion fees, or AI provider costs
the customer pays directly to Deepgram, Groq, Anthropic and similar.

## Edge cases and how the app behaves

- **Cancel then resume before the end date.** Stripe clears the cancellation;
  the webhook sets `cancelsAt` to null. The billing page shows the plan as
  renewing again.
- **Cancel, plan ends, subscribe again.** Checkout is allowed once the old
  subscription is terminal. Notes in the account are still there and the
  desktop app uploads anything made in the meantime.
- **Already has a live subscription and clicks Start Pro/Team.** The app
  sends the owner to Manage billing (`BillingPortalRequiredError`) instead of
  creating a second subscription.
- **Plan switch (Pro to Team, monthly to yearly).** The portal is configured
  with `subscription_update` for the four AI Notetaker prices and
  `proration_behavior: create_prorations`. The `customer.subscription.updated`
  event maps the new price to a plan through `planForPrice`, which knows both
  the monthly and yearly price ids. If you add or replace a price, update the
  `STRIPE_PRICE_HOSTED_*` variables **and** the portal configuration.
- **Unmapped price.** A paid subscription on a price that is not configured is
  logged and sent to Sentry (`paid subscription ignored`). The customer is not
  given a plan until the price is mapped.
- **Failed first payment.** An incomplete subscription never gets access and
  never degrades an existing plan.
- **Late or out-of-order Stripe events.** Older events do not overwrite newer
  state (`lastBillingEventCreatedAt`); a late "updated" cannot revive a
  cancelled subscription.
- **Member of a cancelled Team.** Read-only access to the workspace's notes
  and export; no editing, sharing, integrations, invitations or uploads.

## Disputes (chargebacks)

The billing webhook does not listen for `charge.dispute.created`, so a
dispute does not change access automatically. When you get a dispute notice:

1. Check whether the customer contacted us first and whether a refund was
   already due under the table above. If it was, refund it and let the dispute
   close.
2. If the charge was valid, submit evidence in Stripe (plan, dates, sync
   activity) and, if the dispute stays open, cancel the subscription
   immediately from the Stripe dashboard so sync pauses. Notes stay readable
   and exportable.

Automating this (subscribe the endpoint to `charge.dispute.created`, resolve
the workspace through the charge's customer, and cancel) is a reasonable
follow-up if disputes become frequent.

## Customer portal settings (Stripe, live)

- Cancel: at period end, no proration, cancellation reason collected.
- Plan updates: enabled for the Pro and Team monthly and yearly prices,
  prorated.
- Pause: off. Payment method and invoice history: on.
