import {
  redactSensitiveData,
  type AuditEvent,
  type ChangeAction,
  type CurrentState,
  type DSPManifest,
  type DSPPlan,
  type ContractCheck,
  type OperationRecord,
  type ValidationResult,
  type VerificationResult,
} from '@dsp/protocol'
import { bold, cyan, dim, gray, green, red, riskColor, yellow } from './style.js'

const ACTION_GLYPH: Record<ChangeAction, string> = {
  create: '+',
  update: '~',
  replace: '±',
  delete: '-',
  noop: '=',
  blocked: '✗',
}

function actionLabel(action: ChangeAction): string {
  const text = `${ACTION_GLYPH[action]} ${action.toUpperCase()}`
  switch (action) {
    case 'create':
      return green(text)
    case 'update':
      return yellow(text)
    case 'replace':
    case 'delete':
      return red(text)
    case 'blocked':
      return red(text)
    case 'noop':
      return gray(text)
  }
}

export function renderManifest(manifest: DSPManifest): string {
  const features = Object.entries(manifest.features)
    .map(([name, value]) => `  ${value ? green('✓') : red('✗')} ${name}`)
    .join('\n')

  return [
    bold('DSP SERVER'),
    '',
    `  Server:            ${manifest.server.name} ${manifest.server.version}`,
    `  Protocol version:  ${manifest.protocolVersion}`,
    `  Authentication:    ${manifest.authentication.join(', ')}`,
    '',
    bold('Features'),
    features,
    '',
    bold('Limits'),
    `  Max document size: ${manifest.limits.maxDocumentBytes} bytes`,
    `  Max resources:     ${manifest.limits.maxResources}`,
    `  Max changes:       ${manifest.limits.maxChanges}`,
    `  Plan TTL:          ${manifest.limits.planTtlSeconds}s`,
    '',
  ].join('\n')
}

export function renderValidation(result: ValidationResult): string {
  const lines = [bold('DSP VALIDATE'), '']

  if (result.valid) {
    lines.push(`  ${green('✓')} The document is valid`)
  } else {
    lines.push(`  ${red('✗')} The document is not valid`, '')
    for (const issue of result.errors) {
      lines.push(`  ${red(issue.code)} ${issue.path === '' ? '' : cyan(issue.path)}`)
      lines.push(`    ${issue.message}`)
    }
  }

  if (result.warnings.length > 0) {
    lines.push('', bold('Warnings'))
    for (const warning of result.warnings) {
      lines.push(`  ${yellow(warning.code)} ${cyan(warning.path)}`)
      lines.push(`    ${warning.message}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

export function renderCurrentState(state: CurrentState): string {
  return [
    bold('DSP INSPECT'),
    '',
    `  Resource type: ${state.resourceType}`,
    `  Resource id:   ${state.resourceId ?? dim('(none)')}`,
    `  Observed at:   ${state.observedAt}`,
    `  Revision:      ${state.revision ?? dim('(none)')}`,
    '',
    bold('State'),
    indent(JSON.stringify(redactSensitiveData(state.state), null, 2), '  '),
    '',
  ].join('\n')
}

export function renderPlan(plan: DSPPlan): string {
  const lines = [
    bold('DSP PLAN'),
    '',
    `  Resource: ${plan.metadata.kind}/${plan.metadata.resourceName} ${dim(`(namespace ${plan.metadata.namespace})`)}`,
    `  Provider: ${plan.metadata.provider}`,
    `  Risk:     ${riskColor(plan.summary.risk)} ${dim(`(score ${plan.summary.riskScore})`)}`,
    '',
    bold('Changes:'),
  ]

  if (plan.changes.length === 0) {
    lines.push(`  ${dim('no changes — the desired state already holds')}`)
  }

  for (const change of plan.changes) {
    lines.push(
      `  ${actionLabel(change.action)} ${change.resourceType}/${shortKey(change.resourceKey)}`,
    )
    lines.push(`      ${dim(change.reason)}`)
    for (const field of change.fields.slice(0, 12)) {
      lines.push(
        `      ${cyan(field.path)}: ${red(preview(field.before))} ${dim('→')} ${green(preview(field.after))}${
          field.immutable ? ` ${yellow('(immutable)')}` : ''
        }`,
      )
    }
    if (change.fields.length > 12) {
      lines.push(`      ${dim(`… and ${change.fields.length - 12} more fields`)}`)
    }
  }

  if (plan.contract !== null) {
    lines.push('', ...renderContract(plan.contract, 'Contract', 'constraint'))
  }

  lines.push(
    '',
    bold('Summary:'),
    `  Create:   ${plan.summary.create}`,
    `  Update:   ${plan.summary.update}`,
    `  Replace:  ${plan.summary.replace}`,
    `  Delete:   ${plan.summary.delete}`,
    `  Noop:     ${plan.summary.noop}`,
    `  Blocked:  ${plan.summary.blocked}`,
    '',
  )

  if (plan.policyEvaluation.decisions.length > 0) {
    lines.push(bold('Policy:'))
    for (const decision of plan.policyEvaluation.decisions) {
      const marker =
        decision.effect === 'deny'
          ? red('DENY')
          : decision.effect === 'requireApproval'
            ? yellow('APPROVAL')
            : decision.effect === 'warn'
              ? yellow('WARN')
              : green('ALLOW')
      lines.push(`  ${marker} ${decision.policyId}/${decision.ruleId}: ${decision.message}`)
    }
    lines.push('')
  }

  lines.push(
    `  Executable:        ${plan.executable ? green('yes') : red('no')}`,
    `  Approval required: ${plan.approvals.required ? yellow('yes') : green('no')}`,
    `  Plan ID:           ${plan.metadata.id}`,
    `  Plan hash:         ${plan.metadata.planHash}`,
    `  Expires at:        ${plan.metadata.expiresAt}`,
    '',
  )

  return lines.join('\n')
}

export function renderOperation(operation: OperationRecord, title = 'DSP APPLY'): string {
  const lines = [bold(title), '']

  for (const change of operation.changes) {
    const glyph =
      change.status === 'succeeded'
        ? green('✓')
        : change.status === 'blocked'
          ? red('✗')
          : change.status === 'failed'
            ? red('✗')
            : dim('·')
    const suffix = change.error == null ? '' : ` ${dim(`— ${change.error.message}`)}`
    lines.push(
      `  ${glyph} ${change.action} ${change.resourceType}/${shortKey(change.resourceKey)} ${dim(`[${change.status}]`)}${suffix}`,
    )
  }

  if (operation.changes.length === 0) lines.push(`  ${dim('no changes executed')}`)

  lines.push('', `  Operation: ${operation.id}`, `  Status:    ${statusColor(operation.status)}`)

  if (operation.verification !== null) {
    lines.push(
      `  Verified:  ${verificationColor(operation.verification.status)} ${dim(
        `(satisfaction ${(operation.verification.satisfaction * 100).toFixed(0)}%)`,
      )}`,
    )
    for (const mismatch of operation.verification.unmatched.slice(0, 10)) {
      lines.push(`    ${red('✗')} ${cyan(mismatch.path)}: ${mismatch.reason}`)
    }

    if (operation.verification.contract !== null) {
      lines.push('', ...renderContract(operation.verification.contract, 'Goal', 'condition'))
    }
  }

  if (operation.error != null) {
    lines.push('', `  ${red(operation.error.code)}: ${operation.error.message}`)
  }

  lines.push('')
  return lines.join('\n')
}

export function renderVerification(result: VerificationResult): string {
  const lines = [
    bold('DSP VERIFY'),
    '',
    `  Operation:    ${result.operationId}`,
    `  Status:       ${verificationColor(result.status)}`,
    `  Satisfaction: ${(result.satisfaction * 100).toFixed(0)}%`,
    `  Verified at:  ${result.verifiedAt}`,
    '',
  ]

  if (result.matched.length > 0) {
    lines.push(bold(`Matched (${result.matched.length})`))
    for (const path of result.matched.slice(0, 20)) lines.push(`  ${green('✓')} ${path}`)
    if (result.matched.length > 20) {
      lines.push(`  ${dim(`… and ${result.matched.length - 20} more`)}`)
    }
    lines.push('')
  }

  if (result.unmatched.length > 0) {
    lines.push(bold(`Unmatched (${result.unmatched.length})`))
    for (const mismatch of result.unmatched) {
      lines.push(`  ${red('✗')} ${cyan(mismatch.path)}`)
      lines.push(`      ${mismatch.reason}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

export function renderAudit(events: readonly AuditEvent[]): string {
  const lines = [bold('DSP AUDIT'), '']

  if (events.length === 0) lines.push(`  ${dim('no events')}`)

  for (const event of events) {
    const outcome =
      event.outcome === 'success'
        ? green(event.outcome)
        : event.outcome === 'blocked'
          ? yellow(event.outcome)
          : red(event.outcome)
    lines.push(
      `  ${dim(String(event.sequence).padStart(5))} ${event.timestamp} ${bold(event.action.padEnd(18))} ${outcome}`,
    )
    lines.push(
      `        ${dim(`${event.actor.type}:${event.actor.id}`)}${
        event.planId === undefined ? '' : dim(` plan=${event.planId}`)
      }${event.operationId === undefined ? '' : dim(` op=${event.operationId}`)}`,
    )
  }

  lines.push('')
  return lines.join('\n')
}

export function renderResourceTypes(items: ReadonlyArray<Record<string, unknown>>): string {
  const lines = [bold('DSP RESOURCE TYPES'), '']
  for (const item of items) {
    const metadata = item['metadata'] as { name?: string } | undefined
    const spec = item['spec'] as
      | { provider?: string; capabilities?: Record<string, boolean>; description?: string | null }
      | undefined
    const capabilities = Object.entries(spec?.capabilities ?? {})
      .map(([name, value]) => (value ? green(name) : dim(name)))
      .join(' ')
    lines.push(`  ${bold(String(metadata?.name))} ${dim(`(${String(spec?.provider)})`)}`)
    if (spec?.description != null) lines.push(`      ${dim(spec.description)}`)
    lines.push(`      ${capabilities}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * A contract is the difference between "the world matches the document" and "the
 * change achieved what it was for", so an unmet predicate is printed with its own
 * message rather than folded into the status line.
 */
function renderContract(check: ContractCheck, title: string, noun: string): string[] {
  const lines = [bold(`${title}:`)]

  if (check.goal !== null) lines.push(`  ${check.goal}`)

  if (check.predicates.length === 0) {
    if (check.goal === null) lines.push(`  ${dim(`no ${noun}s declared`)}`)
    return lines
  }

  lines.push(
    `  ${check.satisfied ? green('✓ satisfied') : red('✗ not satisfied')} ${dim(
      `(${check.predicates.length} ${noun}${check.predicates.length === 1 ? '' : 's'})`,
    )}`,
  )

  for (const result of check.predicates) {
    // An unevaluable predicate is neither a pass nor a fail: say so.
    const glyph = result.error !== null ? yellow('!') : result.satisfied ? green('✓') : red('✗')
    lines.push(`    ${glyph} ${result.id}`)
    if (result.error !== null)
      lines.push(`        ${yellow(`could not evaluate: ${result.error}`)}`)
    else if (!result.satisfied && result.message !== null)
      lines.push(`        ${dim(result.message)}`)
  }

  return lines
}

function statusColor(status: OperationRecord['status']): string {
  switch (status) {
    case 'completed':
      return green(status)
    case 'failed':
    case 'verification_failed':
    case 'goal_not_satisfied':
      return red(status)
    case 'partially_completed':
    case 'cancelled':
      return yellow(status)
    default:
      return status
  }
}

function verificationColor(status: VerificationResult['status']): string {
  switch (status) {
    case 'satisfied':
      return green(status)
    case 'partially_satisfied':
      return yellow(status)
    default:
      return red(status)
  }
}

function shortKey(resourceKey: string): string {
  const slash = resourceKey.indexOf('/')
  return slash === -1 ? resourceKey : resourceKey.slice(slash + 1)
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return '(none)'
  if (typeof value === 'string') return value.length > 48 ? `${value.slice(0, 45)}…` : value
  const serialized = JSON.stringify(value)
  return serialized.length > 48 ? `${serialized.slice(0, 45)}…` : serialized
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}
