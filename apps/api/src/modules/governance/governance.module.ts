import { Module } from '@nestjs/common';
import { GovernanceController } from './governance.controller';
import { GovernanceEvidenceController } from './governance-evidence.controller';
import { GovernanceService } from './governance.service';
import { PolicyService } from './policy.service';
import { PolicyContextService } from './policy-context.service';
import { NodeGovernanceProfilerService } from './node-governance-profiler.service';
import { PolicyDecisionEngine } from './policy-decision.engine';
import { EvidencePackService } from './evidence-pack.service';
import { GovernanceFingerprintService } from './governance-fingerprint.service';
import { PolicyInjectionEngine } from './policy-injection.engine';
import { DriftDetectionService } from './drift-detection.service';
import { RuntimeGovernanceService } from './runtime-governance.service';
import { FdsAlertBridgeService } from './fds-alert-bridge.service';
import { AutoActionSelectorService } from './auto-action-selector.service';
import { RuntimeGovernanceController } from './runtime-governance.controller';

/**
 * Governance Core — common policy/context services plus:
 *  - Patent 1 (runtime): NodeGovernanceProfiler, PolicyDecisionEngine,
 *    EvidencePack (hash chain)
 *  - Patent 2 (registration): GovernanceFingerprint, PolicyInjection,
 *    DriftDetection
 */
@Module({
  controllers: [GovernanceController, GovernanceEvidenceController, RuntimeGovernanceController],
  providers: [
    GovernanceService,
    PolicyService,
    PolicyContextService,
    NodeGovernanceProfilerService,
    PolicyDecisionEngine,
    EvidencePackService,
    GovernanceFingerprintService,
    PolicyInjectionEngine,
    DriftDetectionService,
    RuntimeGovernanceService,
    FdsAlertBridgeService,
    AutoActionSelectorService,
  ],
  exports: [
    GovernanceService,
    PolicyService,
    PolicyContextService,
    NodeGovernanceProfilerService,
    PolicyDecisionEngine,
    EvidencePackService,
    GovernanceFingerprintService,
    PolicyInjectionEngine,
    DriftDetectionService,
    RuntimeGovernanceService,
    FdsAlertBridgeService,
    AutoActionSelectorService,
  ],
})
export class GovernanceModule {}
