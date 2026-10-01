import { test } from "node:test";
import assert from "node:assert/strict";
import { model } from "./scale-cost-model.mjs";

test("registering local users alone incurs only the explicit free-user allowance", () => {
  assert.equal(model({ paidFraction: 0 }).modeledMonthlyCostUSD, 0);
  assert.equal(model({ paidFraction: 0, freeUserMonthlyAllowance: 0.001 }).modeledMonthlyCostUSD, 100_000);
});
test("variable work scales with paid hours and includes both egress hops", () => {
  const one = model({ registeredUsers: 1, paidFraction: 1, hoursPerPaidUser: 1 });
  const two = model({ registeredUsers: 2, paidFraction: 1, hoursPerPaidUser: 1 });
  assert.equal(two.monthlyUploadGB, one.monthlyUploadGB * 2);
  assert.equal(two.modeledMonthlyCostUSD, one.modeledMonthlyCostUSD * 2);
  const withoutEgress = model({ registeredUsers: 1, paidFraction: 1, hoursPerPaidUser: 1, egressPerGB: 0 });
  assert.ok(Math.abs(one.modeledMonthlyCostUSD - withoutEgress.modeledMonthlyCostUSD - 0.6912 * 0.05 * 2.1) < 1e-9);
});
test("affordable hours produce the target margin and retry inflation reduces them", () => {
  const baseline = model({ registeredUsers: 1, paidFraction: 1 });
  const atTarget = model({ registeredUsers: 1, paidFraction: 1, hoursPerPaidUser: baseline.maxHoursAtTargetMargin });
  assert.ok(Math.abs(atTarget.modeledContributionMargin - 0.7) < 1e-9);
  assert.ok(model({ providerAttemptMultiplier: 2 }).maxHoursAtTargetMargin < baseline.maxHoursAtTargetMargin);
  assert.throws(() => model({ paidFraction: 2 }));
});
