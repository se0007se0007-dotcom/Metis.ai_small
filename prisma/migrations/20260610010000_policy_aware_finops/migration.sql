-- AlterTable
ALTER TABLE "FinOpsTokenLog" ADD COLUMN     "cacheDecisionReasonJson" JSONB,
ADD COLUMN     "cacheKey" TEXT,
ADD COLUMN     "cachePolicyDecision" TEXT,
ADD COLUMN     "dataClass" TEXT,
ADD COLUMN     "evidencePackId" TEXT,
ADD COLUMN     "governanceFingerprintHash" TEXT,
ADD COLUMN     "nodeKey" TEXT,
ADD COLUMN     "policyHash" TEXT,
ADD COLUMN     "promptHash" TEXT,
ADD COLUMN     "riskScore" DOUBLE PRECISION,
ADD COLUMN     "routeReasonJson" JSONB,
ADD COLUMN     "skillId" TEXT,
ADD COLUMN     "workflowId" TEXT;

-- CreateIndex
CREATE INDEX "FinOpsTokenLog_tenantId_cacheKey_idx" ON "FinOpsTokenLog"("tenantId", "cacheKey");

