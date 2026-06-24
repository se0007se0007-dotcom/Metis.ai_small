/**
 * Pack State Machine — re-exports from @metis/types for backward compatibility.
 * The actual implementation lives in packages/types/src/pack-domain.ts
 */
export type { PackStatus, TransitionResult } from '@metis/types';
export { canTransition, nextPipelineStatus } from '@metis/types';
