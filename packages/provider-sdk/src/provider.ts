import type {
  ChangeExecutionResult,
  CurrentState,
  DesiredStateDocument,
  KindDefinition,
  OperationRecord,
  PlanChange,
  ResourceProjection,
  ResourceTypeDefinition,
  SecretReference,
  ValidationResult,
  VerificationResult,
} from '@dsp/protocol'
import type { ProviderContext, ProviderExecutionContext } from './context.js'

export interface ProviderPlanInput<TSpec = unknown, TState = unknown> {
  desired: DesiredStateDocument<TSpec>
  current: CurrentState<TState>
  /** Changes computed by the runtime's generic diff, in dependency order. */
  changes: PlanChange[]
}

/**
 * A DSP provider translates one or more Desired State kinds into a normalized
 * resource projection, and applies individual planned changes.
 *
 * The runtime — not the provider — owns diffing, ordering, risk scoring, policy
 * evaluation, plan immutability and idempotency. A provider that follows this
 * interface gets all of that for free.
 */
export interface DSPProvider<TSpec = unknown, TState = unknown> {
  readonly name: string
  readonly version: string
  readonly kinds: KindDefinition[]
  readonly resourceTypes: ResourceTypeDefinition[]

  /**
   * Secret references the provider needs for a given document. The runtime
   * builds a scoped resolver from exactly this list.
   */
  requiredSecrets(desired: DesiredStateDocument<TSpec>): SecretReference[]

  /** Semantic validation beyond JSON Schema. MUST NOT perform side effects. */
  validate(
    context: ProviderContext,
    desired: DesiredStateDocument<TSpec>,
  ): Promise<ValidationResult>

  /** Reads the actual state of the external system. MUST NOT perform side effects. */
  inspect(
    context: ProviderContext,
    desired: DesiredStateDocument<TSpec>,
  ): Promise<CurrentState<TState>>

  /** Projects the desired document into normalized resources. Pure. */
  normalizeDesired(desired: DesiredStateDocument<TSpec>): Promise<ResourceProjection>

  /** Projects observed state into normalized resources. Pure. */
  normalizeCurrent(current: CurrentState<TState>): Promise<ResourceProjection>

  /**
   * Optional provider-side refinement of the computed changes: annotate
   * reasons, mark a change destructive, or block an unsupported operation.
   * MUST NOT perform side effects and MUST NOT add changes.
   */
  plan?(context: ProviderContext, input: ProviderPlanInput<TSpec, TState>): Promise<PlanChange[]>

  /** Applies exactly one planned change. MUST be idempotent. */
  applyChange(context: ProviderExecutionContext, change: PlanChange): Promise<ChangeExecutionResult>

  /**
   * Optional provider-specific verification. When absent the runtime compares
   * the desired projection against a fresh inspection.
   */
  verify?(
    context: ProviderContext,
    input: { desired: DesiredStateDocument<TSpec>; operation: OperationRecord },
  ): Promise<VerificationResult>
}

export type AnyDSPProvider = DSPProvider<never, never>

/**
 * Structural check used when registering providers from untyped sources.
 */
export function isDSPProvider(value: unknown): value is DSPProvider {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<DSPProvider>
  return (
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.kinds) &&
    Array.isArray(candidate.resourceTypes) &&
    typeof candidate.inspect === 'function' &&
    typeof candidate.applyChange === 'function'
  )
}
