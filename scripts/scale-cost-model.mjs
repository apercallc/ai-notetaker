import { pathToFileURL } from "node:url";

/** Planning assumptions, not measured invoices or guaranteed capacity. USD. */
export const defaults = {
  registeredUsers: 100_000_000,
  paidFraction: 0.01,
  hoursPerPaidUser: 10,
  monthlyPrice: 12,
  speechPerChannelHour: 0.04,
  summaryPerMeeting: 0.0025,
  meetingsPerHour: 2,
  providerAttemptMultiplier: 1.1,
  egressPerGB: 0.05,
  storagePerGBMonth: 0.015,
  stagingResidenceHours: 24,
  writePerMillion: 4.5,
  readPerMillion: 0.36,
  paymentFraction: 0.029,
  billingFraction: 0.007,
  paymentFixed: 0.30,
  infraSupportAllowancePerPaidUser: 1,
  freeUserMonthlyAllowance: 0,
  targetContributionMargin: 0.70,
  peakMultiplier: 10,
};

export function model(overrides = {}) {
  const p = { ...defaults, ...overrides };
  for (const [name, value] of Object.entries(p)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative`);
  }
  if (p.paidFraction > 1 || p.targetContributionMargin >= 1 || p.providerAttemptMultiplier < 1 || p.monthlyPrice === 0) throw new Error("Invalid fraction, attempt multiplier or price");
  const paidUsers = p.registeredUsers * p.paidFraction;
  const hours = paidUsers * p.hoursPerPaidUser;
  const audioGBPerHour = 48_000 * 2 * 2 * 3_600 / 1e9;
  // One web->R2 write, plus worker->provider per attempted transcription.
  const egressPerHour = audioGBPerHour * p.egressPerGB * (1 + p.providerAttemptMultiplier);
  const chunksPerHour = 2 * Math.ceil(audioGBPerHour * 1e9 / 2 / (4 * 1024 * 1024));
  const variablePerHour = 2 * p.speechPerChannelHour * p.providerAttemptMultiplier +
    p.summaryPerMeeting * p.meetingsPerHour * p.providerAttemptMultiplier + egressPerHour +
    chunksPerHour * (p.writePerMillion + p.readPerMillion) / 1e6 +
    audioGBPerHour * p.stagingResidenceHours / 720 * p.storagePerGBMonth;
  const feesPerUser = p.monthlyPrice * (p.paymentFraction + p.billingFraction) + p.paymentFixed;
  const freeAllowance = (p.registeredUsers - paidUsers) * p.freeUserMonthlyAllowance;
  const revenue = paidUsers * p.monthlyPrice;
  const costs = hours * variablePerHour + paidUsers * (feesPerUser + p.infraSupportAllowancePerPaidUser) + freeAllowance;
  const budgetPerUser = p.monthlyPrice * (1 - p.targetContributionMargin) - feesPerUser - p.infraSupportAllowancePerPaidUser;
  return {
    assumptions: p, paidUsers, monthlyAudioHours: hours, monthlyRevenueUSD: revenue,
    modeledMonthlyCostUSD: costs, modeledContributionUSD: revenue - costs,
    modeledContributionMargin: revenue === 0 ? null : (revenue - costs) / revenue,
    variableUSDPerAudioHour: variablePerHour,
    maxHoursAtTargetMargin: Math.max(0, budgetPerUser / variablePerHour),
    rawAudioGBPerHour: audioGBPerHour, uploadChunksPerHour: chunksPerHour,
    monthlyUploadGB: hours * audioGBPerHour,
    averageUploadGBPerSecond: hours * audioGBPerHour / (30 * 24 * 3_600),
    peakUploadGBPerSecond: hours * audioGBPerHour / (30 * 24 * 3_600) * p.peakMultiplier,
    monthlyMeetings: hours * p.meetingsPerHour,
    averageUploadRequestsPerSecond: hours * chunksPerHour / (30 * 24 * 3_600),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const overrides = process.argv[2] ? JSON.parse(process.argv[2]) : {};
  console.log(JSON.stringify(model(overrides), null, 2));
}
