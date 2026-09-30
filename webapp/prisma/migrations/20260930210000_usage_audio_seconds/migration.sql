-- Audio time reserved per processing unit, so a monthly audio-hours cap bounds
-- provider cost independently of the meeting count.
ALTER TABLE "UsageLedgerEntry" ADD COLUMN "audioSeconds" INTEGER NOT NULL DEFAULT 0;
