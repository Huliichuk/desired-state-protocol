import {
  DSPError,
  canonicalEquals,
  changeId,
  flattenValue,
  pathMatchesAny,
  type ChangeAction,
  type FieldDiff,
  type PlanChange,
  type ResourceTypeDefinition,
} from '@dsp/protocol'
import { compareStrings, type NormalizedProjection, type NormalizedResource } from './normalize.js'

export interface DiffOptions {
  /** Deleting resources that disappeared from the desired state. */
  allowDelete: boolean
  /** Replacing resources whose immutable fields changed. */
  allowReplace: boolean
}

export const DEFAULT_DIFF_OPTIONS: DiffOptions = {
  allowDelete: false,
  allowReplace: false,
}

export interface DiffInput {
  desired: NormalizedProjection
  current: NormalizedProjection
  resourceTypes: ReadonlyMap<string, ResourceTypeDefinition>
  options: DiffOptions
}

interface DraftChange {
  intent: ChangeAction
  resource: NormalizedResource
  before: Record<string, unknown> | undefined
  after: Record<string, unknown> | undefined
  fields: FieldDiff[]
  reason: string
}

/**
 * Computes the change set between two normalized projections.
 *
 * The diff is purely structural: it knows nothing about any specific provider,
 * which is what makes plans reproducible and testable in isolation.
 */
export function computeChanges(input: DiffInput): PlanChange[] {
  const drafts: DraftChange[] = []

  for (const desired of input.desired.resources) {
    const current = input.current.byKey.get(desired.key)
    if (current === undefined) {
      drafts.push({
        intent: 'create',
        resource: desired,
        before: undefined,
        after: desired.attributes,
        fields: [],
        reason: `${desired.resourceType} "${desired.key}" does not exist yet`,
      })
      continue
    }

    const fields = fieldDiffs(current.attributes, desired.attributes, definitionFor(input, desired))
    if (fields.length === 0) {
      drafts.push({
        intent: 'noop',
        resource: desired,
        before: current.attributes,
        after: desired.attributes,
        fields: [],
        reason: `${desired.resourceType} "${desired.key}" already matches the desired state`,
      })
      continue
    }

    const immutable = fields.filter((field) => field.immutable)
    if (immutable.length > 0) {
      drafts.push({
        intent: 'replace',
        resource: { ...desired, externalId: current.externalId },
        before: current.attributes,
        after: desired.attributes,
        fields,
        reason: `immutable field(s) changed: ${immutable.map((field) => field.path).join(', ')}`,
      })
      continue
    }

    drafts.push({
      intent: 'update',
      resource: { ...desired, externalId: current.externalId },
      before: current.attributes,
      after: desired.attributes,
      fields,
      reason: `field(s) changed: ${fields.map((field) => field.path).join(', ')}`,
    })
  }

  for (const current of input.current.resources) {
    if (input.desired.byKey.has(current.key)) continue
    drafts.push({
      intent: 'delete',
      resource: current,
      before: current.attributes,
      after: undefined,
      fields: [],
      reason: `${current.resourceType} "${current.key}" is no longer described by the desired state`,
    })
  }

  const changeIdByResourceKey = new Map(
    drafts.map((draft) => [
      draft.resource.key,
      changeId(draft.resource.resourceType, draft.resource.key, draft.intent),
    ]),
  )

  return drafts
    .map((draft) => toPlanChange(draft, input, changeIdByResourceKey, drafts))
    .sort((a, b) => compareStrings(a.resourceKey, b.resourceKey))
}

function toPlanChange(
  draft: DraftChange,
  input: DiffInput,
  changeIdByResourceKey: ReadonlyMap<string, string>,
  drafts: readonly DraftChange[],
): PlanChange {
  const definition = definitionFor(input, draft.resource)
  const id = changeId(draft.resource.resourceType, draft.resource.key, draft.intent)
  const block = blockReason(draft, definition, input.options)
  const action: ChangeAction = block === null ? draft.intent : 'blocked'

  const change: PlanChange = {
    id,
    resourceType: draft.resource.resourceType,
    resourceKey: draft.resource.key,
    action,
    fields: draft.fields,
    reason: block === null ? draft.reason : `${block.message} (intended action: ${draft.intent})`,
    reversible: isReversible(draft.intent),
    destructive: draft.intent === 'delete' || draft.intent === 'replace',
    dependencies: dependenciesFor(draft, changeIdByResourceKey, drafts),
    estimatedRisk: 'low',
  }

  if (draft.before !== undefined) change.before = draft.before
  if (draft.after !== undefined) change.after = draft.after
  if (draft.fields.length === 1 && draft.fields[0] !== undefined) change.path = draft.fields[0].path
  if (block !== null) change.blockedBy = block.code

  return change
}

function blockReason(
  draft: DraftChange,
  definition: ResourceTypeDefinition | undefined,
  options: DiffOptions,
): { code: string; message: string } | null {
  if (draft.intent === 'noop') return null

  if (definition !== undefined && !definition.capabilities.apply) {
    return {
      code: 'UNSUPPORTED_OPERATION',
      message: `Resource type ${draft.resource.resourceType} does not support apply`,
    }
  }

  if (draft.intent === 'delete') {
    if (!options.allowDelete) {
      return {
        code: 'DESTRUCTIVE_ACTION_BLOCKED',
        message: 'Deletions are disabled for this runtime',
      }
    }
    if (definition !== undefined && !definition.capabilities.delete) {
      return {
        code: 'UNSUPPORTED_OPERATION',
        message: `Resource type ${draft.resource.resourceType} does not support delete`,
      }
    }
  }

  if (draft.intent === 'replace' && !options.allowReplace) {
    return {
      code: 'DESTRUCTIVE_ACTION_BLOCKED',
      message: 'Replacing a resource requires deleting it first, which is disabled',
    }
  }

  return null
}

function isReversible(intent: ChangeAction): boolean {
  // `create` is only reversible by deleting, which the MVP blocks; `replace`
  // and `delete` destroy state that DSP cannot restore.
  return intent === 'update' || intent === 'noop'
}

function dependenciesFor(
  draft: DraftChange,
  changeIdByResourceKey: ReadonlyMap<string, string>,
  drafts: readonly DraftChange[],
): string[] {
  if (draft.intent === 'delete') {
    // Deletion order is the reverse of creation order: a resource may only be
    // removed once everything depending on it is gone.
    return drafts
      .filter(
        (other) =>
          other.intent === 'delete' && other.resource.dependsOn.includes(draft.resource.key),
      )
      .map((other) => changeIdByResourceKey.get(other.resource.key))
      .filter((id): id is string => id !== undefined)
      .sort(compareStrings)
  }

  return draft.resource.dependsOn
    .map((key) => changeIdByResourceKey.get(key))
    .filter((id): id is string => id !== undefined)
    .sort(compareStrings)
}

function definitionFor(
  input: DiffInput,
  resource: NormalizedResource,
): ResourceTypeDefinition | undefined {
  return input.resourceTypes.get(resource.resourceType)
}

/**
 * Leaf-level comparison of two attribute objects. Paths present on only one
 * side are reported with `undefined` on the missing side.
 */
export function fieldDiffs(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  definition: ResourceTypeDefinition | undefined,
): FieldDiff[] {
  const beforeLeaves = flattenValue(before)
  const afterLeaves = flattenValue(after)
  const paths = [...new Set([...beforeLeaves.keys(), ...afterLeaves.keys()])].sort(compareStrings)

  const immutableFields = definition?.immutableFields ?? []

  const diffs: FieldDiff[] = []
  for (const path of paths) {
    const beforeValue = beforeLeaves.get(path)
    const afterValue = afterLeaves.get(path)
    if (canonicalEquals(beforeValue ?? null, afterValue ?? null)) continue

    // Immutability is about *changing* a value. A path that appears on only one
    // side is an addition or a removal, not a mutation of an immutable field —
    // otherwise appending an item to a list would look like rewriting history.
    const bothPresent = beforeLeaves.has(path) && afterLeaves.has(path)

    diffs.push({
      path,
      before: beforeValue ?? null,
      after: afterValue ?? null,
      immutable: bothPresent && pathMatchesAny(path, immutableFields),
    })
  }

  // An empty object or array is flattened to a leaf so that "became empty" stays
  // visible. When the other side expanded that container, the container's own
  // entry is noise sitting on top of the real leaf changes — and a stray parent
  // path could match a policy `pathPrefix` that no real field matches.
  const changed = diffs.map((diff) => diff.path)
  return diffs.filter((diff) => !changed.some((other) => isAncestorPath(diff.path, other)))
}

function isAncestorPath(candidate: string, path: string): boolean {
  if (candidate === path) return false
  if (candidate === '') return true
  return path.startsWith(`${candidate}.`) || path.startsWith(`${candidate}[`)
}

export function assertChangeLimit(changes: readonly PlanChange[], maxChanges: number): void {
  if (changes.length > maxChanges) {
    throw new DSPError(
      'TOO_MANY_CHANGES',
      `Plan contains ${changes.length} changes, limit is ${maxChanges}`,
      { details: { changes: changes.length, limit: maxChanges } },
    )
  }
}
