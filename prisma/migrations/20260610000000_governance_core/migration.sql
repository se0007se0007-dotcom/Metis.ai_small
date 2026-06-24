-- CreateEnum
CREATE TYPE "GovernanceDecisionType" AS ENUM ('ALLOW', 'WARN', 'REQUIRE_APPROVAL', 'BLOCK', 'QUARANTINE');

-- CreateEnum
CREATE TYPE "GovernanceFingerprintStatus" AS ENUM ('DRAFT', 'APPROVED', 'DRIFTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SandboxReplayStatus" AS ENUM ('RUNNING', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "GovernancePatchType" AS ENUM ('ADD_POLICY_CHECKPOINT', 'ADD_HUMAN_APPROVAL', 'ADD_FALLBACK');

-- CreateEnum
CREATE TYPE "OrbGovernanceStatus" AS ENUM ('DRAFT', 'TEMP_REGISTERED', 'NODE_RESOLVED', 'FINGERPRINTED', 'SANDBOX_REPLAYED', 'AUTO_SCORED', 'NEEDS_REPAIR', 'POLICY_INJECTED', 'HUMAN_REVIEW', 'APPROVED', 'PROMOTED', 'ACTIVE', 'REJECTED', 'REVOKED', 'DRIFT_DETECTED', 'REVIEW_EXPIRED');

-- CreateTable
CREATE TABLE "NodeGovernanceProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workflowVersionId" TEXT,
    "nodeKey" TEXT NOT NULL,
    "executionType" TEXT NOT NULL,
    "capability" TEXT,
    "actionType" TEXT,
    "riskLevel" TEXT NOT NULL DEFAULT 'LOW',
    "dataClass" TEXT,
    "policyCheckpoint" BOOLEAN NOT NULL DEFAULT false,
    "humanApproval" BOOLEAN NOT NULL DEFAULT false,
    "connectorScopeHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NodeGovernanceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernanceDecision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "executionSessionId" TEXT NOT NULL,
    "executionStepId" TEXT,
    "workflowId" TEXT,
    "nodeKey" TEXT,
    "policyVersionHash" TEXT,
    "decision" "GovernanceDecisionType" NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'LOW',
    "reasonJson" JSONB NOT NULL,
    "gateResultsJson" JSONB NOT NULL,
    "autoActionJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GovernanceDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidencePack" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'RUNTIME',
    "executionSessionId" TEXT,
    "workflowId" TEXT,
    "workflowVersionId" TEXT,
    "governanceDecisionId" TEXT,
    "orbGovernanceReviewId" TEXT,
    "policyVersionHash" TEXT,
    "workflowHash" TEXT,
    "promptHash" TEXT,
    "modelId" TEXT,
    "connectorIdsJson" JSONB,
    "evaluationJson" JSONB NOT NULL,
    "fdsAlertIdsJson" JSONB,
    "autoActionJson" JSONB,
    "previousHash" TEXT,
    "packHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidencePack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernanceFingerprint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowId" TEXT,
    "workflowVersionId" TEXT,
    "agentId" TEXT,
    "nodeGraphHash" TEXT NOT NULL,
    "connectorScopeHash" TEXT NOT NULL,
    "policyVersionHash" TEXT NOT NULL,
    "modelTierHash" TEXT NOT NULL,
    "dataClassHash" TEXT NOT NULL,
    "budgetHash" TEXT NOT NULL,
    "actionRiskHash" TEXT NOT NULL,
    "fingerprintHash" TEXT NOT NULL,
    "status" "GovernanceFingerprintStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GovernanceFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxReplayRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "fingerprintHash" TEXT NOT NULL,
    "datasetId" TEXT,
    "status" "SandboxReplayStatus" NOT NULL DEFAULT 'RUNNING',
    "readinessScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "securityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "policyScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reliabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "humanReviewScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "replayResultHash" TEXT,
    "resultJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SandboxReplayRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernancePatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "patchType" "GovernancePatchType" NOT NULL,
    "beforeJson" JSONB NOT NULL,
    "afterJson" JSONB NOT NULL,
    "reasonJson" JSONB NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GovernancePatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrbGovernanceReview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "status" "OrbGovernanceStatus" NOT NULL DEFAULT 'DRAFT',
    "fingerprintHash" TEXT,
    "replayRunId" TEXT,
    "readinessScore" DOUBLE PRECISION,
    "reviewerId" TEXT,
    "approvalHash" TEXT,
    "approvedAt" TIMESTAMP(3),
    "promotedVersionId" TEXT,
    "rejectionReason" TEXT,
    "historyJson" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrbGovernanceReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NodeGovernanceProfile_tenantId_workflowId_idx" ON "NodeGovernanceProfile"("tenantId", "workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "NodeGovernanceProfile_tenantId_workflowId_nodeKey_key" ON "NodeGovernanceProfile"("tenantId", "workflowId", "nodeKey");

-- CreateIndex
CREATE INDEX "GovernanceDecision_tenantId_executionSessionId_idx" ON "GovernanceDecision"("tenantId", "executionSessionId");

-- CreateIndex
CREATE INDEX "GovernanceDecision_tenantId_decision_createdAt_idx" ON "GovernanceDecision"("tenantId", "decision", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvidencePack_packHash_key" ON "EvidencePack"("packHash");

-- CreateIndex
CREATE INDEX "EvidencePack_tenantId_executionSessionId_idx" ON "EvidencePack"("tenantId", "executionSessionId");

-- CreateIndex
CREATE INDEX "EvidencePack_tenantId_kind_createdAt_idx" ON "EvidencePack"("tenantId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GovernanceFingerprint_fingerprintHash_key" ON "GovernanceFingerprint"("fingerprintHash");

-- CreateIndex
CREATE INDEX "GovernanceFingerprint_tenantId_workflowId_idx" ON "GovernanceFingerprint"("tenantId", "workflowId");

-- CreateIndex
CREATE INDEX "GovernanceFingerprint_tenantId_status_idx" ON "GovernanceFingerprint"("tenantId", "status");

-- CreateIndex
CREATE INDEX "SandboxReplayRun_tenantId_workflowId_idx" ON "SandboxReplayRun"("tenantId", "workflowId");

-- CreateIndex
CREATE INDEX "SandboxReplayRun_tenantId_fingerprintHash_idx" ON "SandboxReplayRun"("tenantId", "fingerprintHash");

-- CreateIndex
CREATE INDEX "GovernancePatch_tenantId_workflowId_nodeKey_idx" ON "GovernancePatch"("tenantId", "workflowId", "nodeKey");

-- CreateIndex
CREATE INDEX "OrbGovernanceReview_tenantId_workflowId_idx" ON "OrbGovernanceReview"("tenantId", "workflowId");

-- CreateIndex
CREATE INDEX "OrbGovernanceReview_tenantId_status_idx" ON "OrbGovernanceReview"("tenantId", "status");

