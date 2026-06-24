-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('PLATFORM_ADMIN', 'TENANT_ADMIN', 'OPERATOR', 'DEVELOPER', 'AUDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "PackSourceType" AS ENUM ('GITHUB', 'MCP', 'N8N', 'MANUAL', 'INTERNAL');

-- CreateEnum
CREATE TYPE "PackStatus" AS ENUM ('DRAFT', 'IMPORTED', 'VALIDATED', 'CERTIFIED', 'PUBLISHED', 'DEPRECATED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "InstallationStatus" AS ENUM ('INSTALLED', 'DISABLED', 'UPGRADE_AVAILABLE', 'FAILED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'IMPORT', 'INSTALL', 'UNINSTALL', 'EXECUTE', 'CERTIFY', 'REVOKE_CERTIFICATION', 'PUBLISH', 'LOGIN', 'POLICY_CHECK', 'STATUS_TRANSITION', 'BLOCK', 'DEPRECATE', 'REPLAY_DATASET_CREATE', 'REPLAY_RUN_START', 'SHADOW_CONFIG_CREATE', 'SHADOW_PAIR_CREATE', 'CANARY_START', 'CANARY_GATE_EVALUATE', 'CANARY_PROMOTE', 'CANARY_ROLLBACK', 'VERSION_PROMOTE', 'VERSION_ROLLBACK', 'ARCHIVE', 'RESTORE');

-- CreateEnum
CREATE TYPE "ReplayRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShadowPairStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CanaryStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'PROMOTED', 'ROLLED_BACK', 'FAILED');

-- CreateEnum
CREATE TYPE "CanaryGateResult" AS ENUM ('PASS', 'FAIL', 'WARN', 'PENDING');

-- CreateEnum
CREATE TYPE "PromotionAction" AS ENUM ('PROMOTE', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "BuilderRequestStatus" AS ENUM ('PLANNING', 'VALIDATING', 'EVALUATED', 'SAVED', 'REPAIR_LOOP', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReadinessBand" AS ENUM ('EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "MissionStatus" AS ENUM ('PLANNING', 'RUNNING', 'WAITING_HUMAN', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "AgentMessageKind" AS ENUM ('REQUEST', 'RESPONSE', 'EVENT', 'HANDOFF', 'HUMAN_INTERVENTION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AutoActionKind" AS ENUM ('REMEDIATION', 'ROLLBACK', 'ESCALATION', 'QUARANTINE', 'RATE_ADJUST');

-- CreateEnum
CREATE TYPE "AutoActionStatus" AS ENUM ('EXECUTED', 'VERIFIED', 'REVERTED', 'FAILED');

-- CreateEnum
CREATE TYPE "FDSSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "FDSAlertStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'BLOCKED', 'ESCALATED', 'DISMISSED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "APInvoiceStatus" AS ENUM ('RECEIVED', 'PARSING', 'MATCHING', 'EXCEPTION', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PAID');

-- CreateEnum
CREATE TYPE "APMatchingResult" AS ENUM ('FULL_MATCH', 'PARTIAL_MATCH', 'NO_MATCH', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "CapabilityKind" AS ENUM ('CONNECTOR', 'AGENT', 'ADAPTER', 'TEMPLATE', 'SKILL');

-- CreateEnum
CREATE TYPE "AgentKernelType" AS ENUM ('MCP', 'REST', 'LOCAL', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'DRAINING');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED', 'DELETED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "ruleYaml" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyEvaluation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "executionSessionId" TEXT,
    "result" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pack" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" "PackSourceType" NOT NULL,
    "sourceUrl" TEXT,
    "description" TEXT,
    "icon" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackVersion" (
    "id" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifestJson" JSONB NOT NULL,
    "checksum" TEXT,
    "status" "PackStatus" NOT NULL DEFAULT 'DRAFT',
    "certifiedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "packVersionId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "score" INTEGER,
    "findingsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Certification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackInstallation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "packVersionId" TEXT NOT NULL,
    "status" "InstallationStatus" NOT NULL DEFAULT 'INSTALLED',
    "installedById" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "configJson" JSONB,

    CONSTRAINT "PackInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "configJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packInstallationId" TEXT,
    "workflowKey" TEXT,
    "capabilityKey" TEXT,
    "correlationId" TEXT,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "triggeredById" TEXT,
    "inputJson" JSONB,
    "outputJson" JSONB,
    "costUsd" DECIMAL(12,4),
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionStep" (
    "id" TEXT NOT NULL,
    "executionSessionId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "stepType" TEXT NOT NULL,
    "capabilityKey" TEXT,
    "status" "ExecutionStatus" NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "inputJson" JSONB,
    "outputJson" JSONB,
    "errorMessage" TEXT,
    "latencyMs" INTEGER,

    CONSTRAINT "ExecutionStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionTrace" (
    "id" TEXT NOT NULL,
    "executionSessionId" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "traceJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" "AuditAction" NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "policyResult" TEXT,
    "correlationId" TEXT NOT NULL,
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeArtifact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "contentJson" JSONB,
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplayDataset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filterJson" JSONB,
    "baselineVersionId" TEXT,
    "caseCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplayDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplayCase" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "sourceExecutionId" TEXT,
    "workflowKey" TEXT,
    "capabilityKey" TEXT,
    "packVersionId" TEXT,
    "inputJson" JSONB NOT NULL,
    "expectedOutputJson" JSONB,
    "expectedStatus" TEXT,
    "expectedLatencyMs" INTEGER,
    "isGolden" BOOLEAN NOT NULL DEFAULT false,
    "riskLevel" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplayCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplayRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "candidateVersionId" TEXT NOT NULL,
    "baselineVersionId" TEXT,
    "status" "ReplayRunStatus" NOT NULL DEFAULT 'PENDING',
    "totalCases" INTEGER NOT NULL DEFAULT 0,
    "passedCases" INTEGER NOT NULL DEFAULT 0,
    "failedCases" INTEGER NOT NULL DEFAULT 0,
    "errorCases" INTEGER NOT NULL DEFAULT 0,
    "metricsJson" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "triggeredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplayRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplayCaseResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "executionSessionId" TEXT,
    "actualStatus" TEXT,
    "actualOutputJson" JSONB,
    "actualLatencyMs" INTEGER,
    "actualCostUsd" DECIMAL(12,4),
    "statusMatch" BOOLEAN,
    "outputDiffJson" JSONB,
    "latencyDeltaMs" INTEGER,
    "costDeltaUsd" DECIMAL(12,4),
    "policyViolations" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "verdict" TEXT,
    "verdictReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplayCaseResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShadowConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "controlVersionId" TEXT NOT NULL,
    "candidateVersionId" TEXT NOT NULL,
    "workflowFilter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capabilityFilter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "samplingRate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "totalPairs" INTEGER NOT NULL DEFAULT 0,
    "metricsJson" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShadowConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShadowPair" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "controlExecutionId" TEXT NOT NULL,
    "shadowExecutionId" TEXT,
    "status" "ShadowPairStatus" NOT NULL DEFAULT 'PENDING',
    "controlStatus" TEXT,
    "shadowStatus" TEXT,
    "controlOutputJson" JSONB,
    "shadowOutputJson" JSONB,
    "controlLatencyMs" INTEGER,
    "shadowLatencyMs" INTEGER,
    "controlCostUsd" DECIMAL(12,4),
    "shadowCostUsd" DECIMAL(12,4),
    "outputDiffJson" JSONB,
    "policyViolationsDelta" INTEGER NOT NULL DEFAULT 0,
    "verdict" TEXT,
    "verdictReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShadowPair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanaryDeployment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stableVersionId" TEXT NOT NULL,
    "candidateVersionId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "initialTrafficPct" INTEGER NOT NULL DEFAULT 5,
    "currentTrafficPct" INTEGER NOT NULL DEFAULT 0,
    "maxTrafficPct" INTEGER NOT NULL DEFAULT 100,
    "incrementStepPct" INTEGER NOT NULL DEFAULT 10,
    "windowDurationMs" INTEGER NOT NULL DEFAULT 3600000,
    "workflowFilter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capabilityFilter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tenantSubset" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "CanaryStatus" NOT NULL DEFAULT 'PENDING',
    "currentWindow" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "autoRollbackEnabled" BOOLEAN NOT NULL DEFAULT true,
    "rollbackReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanaryDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanaryGate" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "windowNumber" INTEGER NOT NULL,
    "rulesJson" JSONB NOT NULL,
    "result" "CanaryGateResult" NOT NULL DEFAULT 'PENDING',
    "metricsJson" JSONB,
    "successRate" DOUBLE PRECISION,
    "errorRate" DOUBLE PRECISION,
    "policyViolationCount" INTEGER,
    "avgLatencyMs" INTEGER,
    "p99LatencyMs" INTEGER,
    "avgCostUsd" DECIMAL(12,4),
    "retryCount" INTEGER,
    "invalidOutputCount" INTEGER,
    "evaluatedAt" TIMESTAMP(3),
    "evaluatedById" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanaryGate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanaryMetricSnapshot" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "windowNumber" INTEGER NOT NULL,
    "stableMetricsJson" JSONB NOT NULL,
    "candidateMetricsJson" JSONB NOT NULL,
    "stableSuccessRate" DOUBLE PRECISION,
    "candidateSuccessRate" DOUBLE PRECISION,
    "stableAvgLatencyMs" INTEGER,
    "candidateAvgLatencyMs" INTEGER,
    "totalStableExecs" INTEGER NOT NULL DEFAULT 0,
    "totalCandidateExecs" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanaryMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VersionPromotion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "fromVersionId" TEXT NOT NULL,
    "toVersionId" TEXT NOT NULL,
    "action" "PromotionAction" NOT NULL,
    "reason" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "evaluationSummaryJson" JSONB,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rollbackFromVersionId" TEXT,
    "isEmergency" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VersionPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinOpsConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cacheEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cacheBackend" TEXT NOT NULL DEFAULT 'redis',
    "cacheSimilarityThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.93,
    "cacheTtlSeconds" INTEGER NOT NULL DEFAULT 86400,
    "cacheEmbeddingModel" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    "cacheMaxMemoryMb" INTEGER NOT NULL DEFAULT 1024,
    "cacheWarmupEntries" INTEGER NOT NULL DEFAULT 100,
    "cacheExcludePatterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "routerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "routerStage1Enabled" BOOLEAN NOT NULL DEFAULT true,
    "routerStage2Enabled" BOOLEAN NOT NULL DEFAULT true,
    "routerClassifierModel" TEXT NOT NULL DEFAULT 'claude-haiku-4.5',
    "routerFallbackTier" INTEGER NOT NULL DEFAULT 2,
    "routerTier1Models" TEXT[] DEFAULT ARRAY['claude-haiku-4.5', 'gemini-3-flash', 'gpt-4o-mini']::TEXT[],
    "routerTier2Models" TEXT[] DEFAULT ARRAY['claude-sonnet-4.6', 'gpt-4o', 'gemini-3.1-pro']::TEXT[],
    "routerTier3Models" TEXT[] DEFAULT ARRAY['claude-opus-4.6', 'o3', 'gpt-5']::TEXT[],
    "packerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "packerMaxTokensPerSkill" INTEGER NOT NULL DEFAULT 2000,
    "packerOutputFormat" TEXT NOT NULL DEFAULT 'JSON',
    "alertCacheHitMinPct" INTEGER NOT NULL DEFAULT 20,
    "alertDailyCostMax" DOUBLE PRECISION NOT NULL DEFAULT 50.0,
    "alertTier3MaxPct" INTEGER NOT NULL DEFAULT 30,
    "alertResponseDelayMs" INTEGER NOT NULL DEFAULT 5000,
    "alertSlackEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertSlackChannel" TEXT NOT NULL DEFAULT '#finops-alerts',
    "alertEmailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertEmailAddress" TEXT NOT NULL DEFAULT '',
    "alertPagerDutyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinOpsConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinOpsAgentConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT '운영',
    "cacheEnabled" BOOLEAN NOT NULL DEFAULT true,
    "routerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "packerEnabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedTiers" INTEGER[] DEFAULT ARRAY[1, 2, 3]::INTEGER[],
    "namespace" TEXT NOT NULL DEFAULT 'default',
    "dailyLimitUsd" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinOpsAgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinOpsSkill" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultTier" INTEGER NOT NULL DEFAULT 1,
    "invocationCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT '활성',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinOpsSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinOpsNamespace" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "cacheEntries" INTEGER NOT NULL DEFAULT 0,
    "hitRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ttlPolicy" TEXT NOT NULL DEFAULT '24h',
    "status" TEXT NOT NULL DEFAULT '활성',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinOpsNamespace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinOpsTokenLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "executionSessionId" TEXT,
    "nodeId" TEXT,
    "promptText" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "cachedResponseUsed" BOOLEAN NOT NULL DEFAULT false,
    "routedTier" INTEGER NOT NULL DEFAULT 2,
    "routedModel" TEXT NOT NULL DEFAULT '',
    "originalCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "optimizedCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "savedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "responseTimeMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinOpsTokenLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuilderRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "BuilderRequestStatus" NOT NULL DEFAULT 'PLANNING',
    "userPrompt" TEXT NOT NULL,
    "detectedIntents" JSONB,
    "matchedTemplate" TEXT,
    "planCreatedAt" TIMESTAMP(3),
    "validationDoneAt" TIMESTAMP(3),
    "evalDoneAt" TIMESTAMP(3),
    "savedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuilderRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuilderPlan" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "templateId" TEXT,
    "templateName" TEXT,
    "nodesJson" JSONB NOT NULL,
    "connectorsJson" JSONB,
    "policiesJson" JSONB,
    "parametersJson" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuilderPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuilderParamSet" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "parametersJson" JSONB NOT NULL,
    "unresolvedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuilderParamSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuilderConnectorGap" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "connectorKey" TEXT NOT NULL,
    "connectorName" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requiredSecrets" JSONB,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuilderConnectorGap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuilderValidationResult" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "isValid" BOOLEAN NOT NULL DEFAULT false,
    "canSaveWithWarnings" BOOLEAN NOT NULL DEFAULT false,
    "blockingErrorCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "issuesJson" JSONB NOT NULL,
    "repairActionsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuilderValidationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuilderEvalResult" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "overallScore" INTEGER NOT NULL DEFAULT 0,
    "band" "ReadinessBand" NOT NULL DEFAULT 'CRITICAL',
    "executionReadiness" INTEGER NOT NULL DEFAULT 0,
    "connectorValidity" INTEGER NOT NULL DEFAULT 0,
    "policyCoverage" INTEGER NOT NULL DEFAULT 0,
    "operatorUsability" INTEGER NOT NULL DEFAULT 0,
    "monitoringVisibility" INTEGER NOT NULL DEFAULT 0,
    "subScoresJson" JSONB,
    "issuesJson" JSONB,
    "recommendedFixes" JSONB,
    "simulationJson" JSONB,
    "canSave" BOOLEAN NOT NULL DEFAULT false,
    "requiresAcknowledgement" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuilderEvalResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuilderRepairAction" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "repairType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "targetNodeId" TEXT,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMP(3),
    "resultJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuilderRepairAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "MissionStatus" NOT NULL DEFAULT 'PLANNING',
    "kind" TEXT NOT NULL,
    "participants" JSONB NOT NULL,
    "currentStepIndex" INTEGER NOT NULL DEFAULT 0,
    "plannedStepsJson" JSONB,
    "contextJson" JSONB,
    "correlationId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "autoActionsCount" INTEGER NOT NULL DEFAULT 0,
    "humanInterventionsCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "kind" "AgentMessageKind" NOT NULL,
    "fromAgent" TEXT NOT NULL,
    "toAgent" TEXT,
    "subject" TEXT,
    "payloadJson" JSONB NOT NULL,
    "naturalSummary" TEXT,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentHandoff" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "fromAgent" TEXT NOT NULL,
    "toAgent" TEXT NOT NULL,
    "taskJson" JSONB NOT NULL,
    "status" "HandoffStatus" NOT NULL DEFAULT 'PENDING',
    "acceptedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "resultJson" JSONB,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "missionId" TEXT,
    "kind" "AutoActionKind" NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "triggerReason" TEXT NOT NULL,
    "triggerRuleId" TEXT,
    "actionJson" JSONB NOT NULL,
    "status" "AutoActionStatus" NOT NULL DEFAULT 'EXECUTED',
    "verificationJson" JSONB,
    "revertedAt" TIMESTAMP(3),
    "revertedByUserId" TEXT,
    "revertWindowSec" INTEGER NOT NULL DEFAULT 600,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FDSRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "severity" "FDSSeverity" NOT NULL DEFAULT 'MEDIUM',
    "conditionsJson" JSONB NOT NULL,
    "actionJson" JSONB,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FDSRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FDSAlert" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT,
    "severity" "FDSSeverity" NOT NULL,
    "status" "FDSAlertStatus" NOT NULL DEFAULT 'OPEN',
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "summary" TEXT NOT NULL,
    "detailsJson" JSONB NOT NULL,
    "similarCasesJson" JSONB,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionJson" JSONB,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FDSAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "APInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "vendorId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KRW',
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "status" "APInvoiceStatus" NOT NULL DEFAULT 'RECEIVED',
    "sourceUri" TEXT,
    "parsedJson" JSONB,
    "ocrConfidence" DOUBLE PRECISION,
    "matchingResult" "APMatchingResult",
    "poReference" TEXT,
    "grReference" TEXT,
    "matchingDetailsJson" JSONB,
    "aiSuggestionJson" JSONB,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "APInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "status" "AgentStatus" NOT NULL DEFAULT 'AVAILABLE',
    "kernelType" "AgentKernelType" NOT NULL DEFAULT 'LOCAL',
    "inputSchemaJson" JSONB NOT NULL,
    "outputSchemaJson" JSONB NOT NULL,
    "capabilitiesJson" JSONB NOT NULL,
    "kernelConfigJson" JSONB,
    "defaultTimeoutSec" INTEGER NOT NULL DEFAULT 60,
    "costPerInvocationUsd" DECIMAL(12,6),
    "totalInvocations" INTEGER NOT NULL DEFAULT 0,
    "lastInvokedAt" TIMESTAMP(3),
    "lastSuccessRate" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdapterRegistration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adapterType" TEXT NOT NULL,
    "implementation" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "inputSchemaJson" JSONB NOT NULL,
    "outputSchemaJson" JSONB NOT NULL,
    "configJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdapterRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapabilityBinding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "CapabilityKind" NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "tags" TEXT[],
    "inputSchemaJson" JSONB,
    "outputSchemaJson" JSONB,
    "docsUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapabilityBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "activeVersionId" TEXT,
    "tags" TEXT[],
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "label" TEXT,
    "nodesSnapshot" JSONB NOT NULL,
    "edgesSnapshot" JSONB NOT NULL,
    "settingsSnapshot" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowNodeDef" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "uiType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "executionOrder" INTEGER NOT NULL,
    "configJson" JSONB NOT NULL DEFAULT '{}',
    "inputMappingJson" JSONB,
    "dependsOn" TEXT[],
    "positionX" DOUBLE PRECISION,
    "positionY" DOUBLE PRECISION,

    CONSTRAINT "WorkflowNodeDef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowEdgeDef" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "fromNodeKey" TEXT NOT NULL,
    "toNodeKey" TEXT NOT NULL,
    "edgeType" TEXT NOT NULL DEFAULT 'SEQUENCE',
    "condition" TEXT,
    "label" TEXT,

    CONSTRAINT "WorkflowEdgeDef_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_tenantId_role_idx" ON "Membership"("tenantId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_tenantId_userId_key" ON "Membership"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "Policy_tenantId_isActive_idx" ON "Policy"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_tenantId_key_key" ON "Policy"("tenantId", "key");

-- CreateIndex
CREATE INDEX "PolicyEvaluation_tenantId_policyId_idx" ON "PolicyEvaluation"("tenantId", "policyId");

-- CreateIndex
CREATE INDEX "PolicyEvaluation_executionSessionId_idx" ON "PolicyEvaluation"("executionSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Pack_key_key" ON "Pack"("key");

-- CreateIndex
CREATE INDEX "PackVersion_status_createdAt_idx" ON "PackVersion"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PackVersion_packId_version_key" ON "PackVersion"("packId", "version");

-- CreateIndex
CREATE INDEX "Certification_packVersionId_createdAt_idx" ON "Certification"("packVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "PackInstallation_tenantId_status_idx" ON "PackInstallation"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PackInstallation_tenantId_packId_packVersionId_key" ON "PackInstallation"("tenantId", "packId", "packVersionId");

-- CreateIndex
CREATE INDEX "Connector_tenantId_type_status_idx" ON "Connector"("tenantId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Connector_tenantId_key_key" ON "Connector"("tenantId", "key");

-- CreateIndex
CREATE INDEX "ExecutionSession_tenantId_status_createdAt_idx" ON "ExecutionSession"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ExecutionSession_workflowKey_idx" ON "ExecutionSession"("workflowKey");

-- CreateIndex
CREATE INDEX "ExecutionSession_correlationId_idx" ON "ExecutionSession"("correlationId");

-- CreateIndex
CREATE INDEX "ExecutionStep_executionSessionId_status_idx" ON "ExecutionStep"("executionSessionId", "status");

-- CreateIndex
CREATE INDEX "ExecutionTrace_executionSessionId_idx" ON "ExecutionTrace"("executionSessionId");

-- CreateIndex
CREATE INDEX "ExecutionTrace_correlationId_idx" ON "ExecutionTrace"("correlationId");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_correlationId_idx" ON "AuditLog"("correlationId");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "KnowledgeArtifact_tenantId_category_status_idx" ON "KnowledgeArtifact"("tenantId", "category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeArtifact_tenantId_key_key" ON "KnowledgeArtifact"("tenantId", "key");

-- CreateIndex
CREATE INDEX "ReplayDataset_tenantId_createdAt_idx" ON "ReplayDataset"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ReplayDataset_baselineVersionId_idx" ON "ReplayDataset"("baselineVersionId");

-- CreateIndex
CREATE INDEX "ReplayCase_datasetId_isGolden_idx" ON "ReplayCase"("datasetId", "isGolden");

-- CreateIndex
CREATE INDEX "ReplayCase_datasetId_riskLevel_idx" ON "ReplayCase"("datasetId", "riskLevel");

-- CreateIndex
CREATE INDEX "ReplayRun_tenantId_status_createdAt_idx" ON "ReplayRun"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ReplayRun_candidateVersionId_idx" ON "ReplayRun"("candidateVersionId");

-- CreateIndex
CREATE INDEX "ReplayCaseResult_runId_verdict_idx" ON "ReplayCaseResult"("runId", "verdict");

-- CreateIndex
CREATE INDEX "ReplayCaseResult_caseId_idx" ON "ReplayCaseResult"("caseId");

-- CreateIndex
CREATE INDEX "ShadowConfig_tenantId_isActive_idx" ON "ShadowConfig"("tenantId", "isActive");

-- CreateIndex
CREATE INDEX "ShadowConfig_controlVersionId_idx" ON "ShadowConfig"("controlVersionId");

-- CreateIndex
CREATE INDEX "ShadowPair_configId_status_idx" ON "ShadowPair"("configId", "status");

-- CreateIndex
CREATE INDEX "ShadowPair_tenantId_createdAt_idx" ON "ShadowPair"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ShadowPair_controlExecutionId_idx" ON "ShadowPair"("controlExecutionId");

-- CreateIndex
CREATE INDEX "CanaryDeployment_tenantId_status_idx" ON "CanaryDeployment"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CanaryDeployment_packId_status_idx" ON "CanaryDeployment"("packId", "status");

-- CreateIndex
CREATE INDEX "CanaryGate_deploymentId_windowNumber_idx" ON "CanaryGate"("deploymentId", "windowNumber");

-- CreateIndex
CREATE INDEX "CanaryMetricSnapshot_deploymentId_windowNumber_idx" ON "CanaryMetricSnapshot"("deploymentId", "windowNumber");

-- CreateIndex
CREATE INDEX "VersionPromotion_tenantId_packId_createdAt_idx" ON "VersionPromotion"("tenantId", "packId", "createdAt");

-- CreateIndex
CREATE INDEX "VersionPromotion_action_createdAt_idx" ON "VersionPromotion"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FinOpsConfig_tenantId_key" ON "FinOpsConfig"("tenantId");

-- CreateIndex
CREATE INDEX "FinOpsAgentConfig_tenantId_idx" ON "FinOpsAgentConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FinOpsAgentConfig_tenantId_agentName_key" ON "FinOpsAgentConfig"("tenantId", "agentName");

-- CreateIndex
CREATE INDEX "FinOpsSkill_tenantId_idx" ON "FinOpsSkill"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FinOpsSkill_tenantId_skillId_key" ON "FinOpsSkill"("tenantId", "skillId");

-- CreateIndex
CREATE INDEX "FinOpsNamespace_tenantId_idx" ON "FinOpsNamespace"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FinOpsNamespace_tenantId_namespace_key" ON "FinOpsNamespace"("tenantId", "namespace");

-- CreateIndex
CREATE INDEX "FinOpsTokenLog_tenantId_createdAt_idx" ON "FinOpsTokenLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "FinOpsTokenLog_tenantId_agentName_idx" ON "FinOpsTokenLog"("tenantId", "agentName");

-- CreateIndex
CREATE INDEX "FinOpsTokenLog_executionSessionId_idx" ON "FinOpsTokenLog"("executionSessionId");

-- CreateIndex
CREATE INDEX "BuilderRequest_tenantId_createdAt_idx" ON "BuilderRequest"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "BuilderRequest_tenantId_status_idx" ON "BuilderRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "BuilderRequest_userId_idx" ON "BuilderRequest"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BuilderPlan_requestId_key" ON "BuilderPlan"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "BuilderParamSet_requestId_key" ON "BuilderParamSet"("requestId");

-- CreateIndex
CREATE INDEX "BuilderConnectorGap_requestId_idx" ON "BuilderConnectorGap"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "BuilderValidationResult_requestId_key" ON "BuilderValidationResult"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "BuilderEvalResult_requestId_key" ON "BuilderEvalResult"("requestId");

-- CreateIndex
CREATE INDEX "BuilderRepairAction_requestId_idx" ON "BuilderRepairAction"("requestId");

-- CreateIndex
CREATE INDEX "Mission_tenantId_status_idx" ON "Mission"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Mission_correlationId_idx" ON "Mission"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "Mission_tenantId_key_key" ON "Mission"("tenantId", "key");

-- CreateIndex
CREATE INDEX "AgentMessage_tenantId_missionId_createdAt_idx" ON "AgentMessage"("tenantId", "missionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentMessage_correlationId_idx" ON "AgentMessage"("correlationId");

-- CreateIndex
CREATE INDEX "AgentHandoff_tenantId_missionId_idx" ON "AgentHandoff"("tenantId", "missionId");

-- CreateIndex
CREATE INDEX "AgentHandoff_status_idx" ON "AgentHandoff"("status");

-- CreateIndex
CREATE INDEX "AutoAction_tenantId_status_createdAt_idx" ON "AutoAction"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AutoAction_targetType_targetId_idx" ON "AutoAction"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "FDSRule_tenantId_enabled_idx" ON "FDSRule"("tenantId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "FDSRule_tenantId_key_key" ON "FDSRule"("tenantId", "key");

-- CreateIndex
CREATE INDEX "FDSAlert_tenantId_status_createdAt_idx" ON "FDSAlert"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "FDSAlert_subjectType_subjectId_idx" ON "FDSAlert"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "APInvoice_tenantId_status_createdAt_idx" ON "APInvoice"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "APInvoice_vendorId_idx" ON "APInvoice"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "APInvoice_tenantId_invoiceNumber_key" ON "APInvoice"("tenantId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "AgentDefinition_tenantId_category_status_idx" ON "AgentDefinition"("tenantId", "category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDefinition_tenantId_key_key" ON "AgentDefinition"("tenantId", "key");

-- CreateIndex
CREATE INDEX "AdapterRegistration_tenantId_adapterType_active_idx" ON "AdapterRegistration"("tenantId", "adapterType", "active");

-- CreateIndex
CREATE UNIQUE INDEX "AdapterRegistration_tenantId_key_key" ON "AdapterRegistration"("tenantId", "key");

-- CreateIndex
CREATE INDEX "CapabilityBinding_tenantId_kind_active_idx" ON "CapabilityBinding"("tenantId", "kind", "active");

-- CreateIndex
CREATE INDEX "CapabilityBinding_sourceType_sourceId_idx" ON "CapabilityBinding"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "CapabilityBinding_tenantId_key_key" ON "CapabilityBinding"("tenantId", "key");

-- CreateIndex
CREATE INDEX "Workflow_tenantId_status_updatedAt_idx" ON "Workflow"("tenantId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "Workflow_tenantId_createdById_idx" ON "Workflow"("tenantId", "createdById");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_tenantId_key_key" ON "Workflow"("tenantId", "key");

-- CreateIndex
CREATE INDEX "WorkflowVersion_workflowId_createdAt_idx" ON "WorkflowVersion"("workflowId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_workflowId_versionNumber_key" ON "WorkflowVersion"("workflowId", "versionNumber");

-- CreateIndex
CREATE INDEX "WorkflowNodeDef_workflowId_executionOrder_idx" ON "WorkflowNodeDef"("workflowId", "executionOrder");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowNodeDef_workflowId_nodeKey_key" ON "WorkflowNodeDef"("workflowId", "nodeKey");

-- CreateIndex
CREATE INDEX "WorkflowEdgeDef_workflowId_idx" ON "WorkflowEdgeDef"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowEdgeDef_workflowId_fromNodeKey_toNodeKey_key" ON "WorkflowEdgeDef"("workflowId", "fromNodeKey", "toNodeKey");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyEvaluation" ADD CONSTRAINT "PolicyEvaluation_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackVersion" ADD CONSTRAINT "PackVersion_packId_fkey" FOREIGN KEY ("packId") REFERENCES "Pack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certification" ADD CONSTRAINT "Certification_packVersionId_fkey" FOREIGN KEY ("packVersionId") REFERENCES "PackVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackInstallation" ADD CONSTRAINT "PackInstallation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackInstallation" ADD CONSTRAINT "PackInstallation_packId_fkey" FOREIGN KEY ("packId") REFERENCES "Pack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackInstallation" ADD CONSTRAINT "PackInstallation_packVersionId_fkey" FOREIGN KEY ("packVersionId") REFERENCES "PackVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connector" ADD CONSTRAINT "Connector_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionSession" ADD CONSTRAINT "ExecutionSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionStep" ADD CONSTRAINT "ExecutionStep_executionSessionId_fkey" FOREIGN KEY ("executionSessionId") REFERENCES "ExecutionSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionTrace" ADD CONSTRAINT "ExecutionTrace_executionSessionId_fkey" FOREIGN KEY ("executionSessionId") REFERENCES "ExecutionSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeArtifact" ADD CONSTRAINT "KnowledgeArtifact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplayCase" ADD CONSTRAINT "ReplayCase_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "ReplayDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplayRun" ADD CONSTRAINT "ReplayRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "ReplayDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplayCaseResult" ADD CONSTRAINT "ReplayCaseResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReplayRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplayCaseResult" ADD CONSTRAINT "ReplayCaseResult_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ReplayCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShadowPair" ADD CONSTRAINT "ShadowPair_configId_fkey" FOREIGN KEY ("configId") REFERENCES "ShadowConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanaryGate" ADD CONSTRAINT "CanaryGate_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "CanaryDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanaryMetricSnapshot" ADD CONSTRAINT "CanaryMetricSnapshot_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "CanaryDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinOpsConfig" ADD CONSTRAINT "FinOpsConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinOpsAgentConfig" ADD CONSTRAINT "FinOpsAgentConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinOpsSkill" ADD CONSTRAINT "FinOpsSkill_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinOpsNamespace" ADD CONSTRAINT "FinOpsNamespace_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinOpsTokenLog" ADD CONSTRAINT "FinOpsTokenLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuilderRequest" ADD CONSTRAINT "BuilderRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuilderPlan" ADD CONSTRAINT "BuilderPlan_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BuilderRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuilderParamSet" ADD CONSTRAINT "BuilderParamSet_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BuilderRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuilderConnectorGap" ADD CONSTRAINT "BuilderConnectorGap_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BuilderRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuilderValidationResult" ADD CONSTRAINT "BuilderValidationResult_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BuilderRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuilderEvalResult" ADD CONSTRAINT "BuilderEvalResult_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BuilderRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuilderRepairAction" ADD CONSTRAINT "BuilderRepairAction_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BuilderRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHandoff" ADD CONSTRAINT "AgentHandoff_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHandoff" ADD CONSTRAINT "AgentHandoff_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoAction" ADD CONSTRAINT "AutoAction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoAction" ADD CONSTRAINT "AutoAction_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FDSRule" ADD CONSTRAINT "FDSRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FDSAlert" ADD CONSTRAINT "FDSAlert_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FDSAlert" ADD CONSTRAINT "FDSAlert_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "FDSRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "APInvoice" ADD CONSTRAINT "APInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDefinition" ADD CONSTRAINT "AgentDefinition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdapterRegistration" ADD CONSTRAINT "AdapterRegistration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityBinding" ADD CONSTRAINT "CapabilityBinding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowNodeDef" ADD CONSTRAINT "WorkflowNodeDef_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowEdgeDef" ADD CONSTRAINT "WorkflowEdgeDef_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
