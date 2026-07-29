import { readDocumentFile } from '@dsp/core'
import { Command } from 'commander'
import { DspClient, type ClientOptions } from './client.js'
import { EXIT, type ExitCode } from './exit-codes.js'
import { emit, reportError, warn, type OutputOptions } from './output.js'
import {
  renderAudit,
  renderCurrentState,
  renderManifest,
  renderOperation,
  renderPlan,
  renderResourceTypes,
  renderValidation,
  renderVerification,
} from './render.js'
import { bold, dim, green, red, setColorEnabled, yellow } from './style.js'
import { CLI_VERSION } from './version.js'

const DEFAULT_SERVER = process.env['DSP_SERVER'] ?? 'http://127.0.0.1:4040'

interface GlobalOptions {
  server: string
  token?: string
  json?: boolean
  color?: boolean
  actorId?: string
  actorType?: 'human' | 'agent' | 'system'
}

function outputOptions(options: GlobalOptions): OutputOptions {
  return { json: options.json === true }
}

function clientFrom(options: GlobalOptions): DspClient {
  if (options.color === false) setColorEnabled(false)
  const clientOptions: ClientOptions = { server: options.server }
  const token = options.token ?? process.env['DSP_TOKEN']
  if (token !== undefined) clientOptions.token = token
  if (options.actorId !== undefined) clientOptions.actorId = options.actorId
  if (options.actorType !== undefined) clientOptions.actorType = options.actorType
  return new DspClient(clientOptions)
}

/**
 * Wraps a command body so that every failure path produces the same output
 * format and a meaningful exit code.
 */
function run(handler: () => Promise<ExitCode>, options: GlobalOptions): Promise<void> {
  return handler()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.exitCode = reportError(error, outputOptions(options))
    })
}

export function buildProgram(): Command {
  const program = new Command()

  program
    .name('dsp')
    .description('Desired State Protocol command line client')
    .version(CLI_VERSION)
    .option('-s, --server <url>', 'DSP server base URL', DEFAULT_SERVER)
    .option('-t, --token <token>', 'bearer token (or DSP_TOKEN)')
    .option('--json', 'emit machine-readable JSON')
    .option('--no-color', 'disable ANSI colors')
    .option('--actor-id <id>', 'actor id recorded in the audit log')
    .option('--actor-type <type>', 'actor type: human, agent or system')

  program
    .command('discover')
    .argument('[url]', 'DSP server base URL')
    .description('Read the server manifest and the resource types it publishes')
    .action(async (url: string | undefined, _opts: unknown, command: Command) => {
      const globals = command.optsWithGlobals<GlobalOptions>()
      const options = url === undefined ? globals : { ...globals, server: url }
      await run(async () => {
        const client = clientFrom(options)
        const manifest = await client.manifest()
        const resourceTypes = await client.resourceTypes().catch(() => ({ items: [] }))

        emit(
          outputOptions(options),
          { manifest, resourceTypes: resourceTypes.items },
          () =>
            `${renderManifest(manifest)}${
              resourceTypes.items.length === 0
                ? `${dim('  (resource types require a token)')}\n\n`
                : renderResourceTypes(resourceTypes.items)
            }`,
        )
        return EXIT.ok
      }, options)
    })

  program
    .command('validate')
    .requiredOption('-f, --file <path>', 'Desired State document (YAML or JSON)')
    .description('Validate a document against the schema and the provider. Side-effect free.')
    .action(async (opts: { file: string }, command: Command) => {
      const options = command.optsWithGlobals<GlobalOptions>()
      await run(async () => {
        const document = await readDocumentFile(opts.file)
        const result = await clientFrom(options).validate(document)
        emit(outputOptions(options), result, () => renderValidation(result))
        return result.valid ? EXIT.ok : EXIT.invalidDocument
      }, options)
    })

  program
    .command('inspect')
    .requiredOption('-f, --file <path>', 'Desired State document (YAML or JSON)')
    .description('Read the current state of the external system. Side-effect free.')
    .action(async (opts: { file: string }, command: Command) => {
      const options = command.optsWithGlobals<GlobalOptions>()
      await run(async () => {
        const document = await readDocumentFile(opts.file)
        const state = await clientFrom(options).inspect(document)
        emit(outputOptions(options), state, () => renderCurrentState(state))
        return EXIT.ok
      }, options)
    })

  program
    .command('plan')
    .requiredOption('-f, --file <path>', 'Desired State document (YAML or JSON)')
    .option(
      '--allow-delete',
      'ask the runtime to include deletions (refused unless enabled server-side)',
    )
    .option('--allow-replace', 'ask the runtime to include replacements')
    .description('Build an immutable plan. Side-effect free.')
    .action(
      async (
        opts: { file: string; allowDelete?: boolean; allowReplace?: boolean },
        command: Command,
      ) => {
        const options = command.optsWithGlobals<GlobalOptions>()
        await run(async () => {
          const document = await readDocumentFile(opts.file)
          const plan = await clientFrom(options).plan(document, {
            ...(opts.allowDelete === true ? { allowDelete: true } : {}),
            ...(opts.allowReplace === true ? { allowReplace: true } : {}),
          })
          emit(outputOptions(options), plan, () => renderPlan(plan))

          if (!plan.executable) return EXIT.policyDenied
          return EXIT.ok
        }, options)
      },
    )

  program
    .command('show')
    .argument('<plan-id>')
    .description('Fetch a stored plan')
    .action(async (planId: string, _opts: unknown, command: Command) => {
      const options = command.optsWithGlobals<GlobalOptions>()
      await run(async () => {
        const plan = await clientFrom(options).getPlan(planId)
        emit(outputOptions(options), plan, () => renderPlan(plan))
        return plan.executable ? EXIT.ok : EXIT.policyDenied
      }, options)
    })

  program
    .command('approve')
    .argument('<plan-id>')
    .option('--by <name>', 'who is approving', process.env['USER'] ?? 'local-user')
    .option('--reason <text>', 'why the plan is approved', 'Reviewed plan')
    .option('--plan-hash <hash>', 'the exact plan hash being approved')
    .description('Approve one specific plan hash')
    .action(
      async (
        planId: string,
        opts: { by: string; reason: string; planHash?: string },
        command: Command,
      ) => {
        const options = command.optsWithGlobals<GlobalOptions>()
        await run(async () => {
          const client = clientFrom(options)
          const plan = await client.getPlan(planId)
          const planHash = opts.planHash ?? plan.metadata.planHash

          const approval = await client.approve(planId, {
            approvedBy: opts.by,
            reason: opts.reason,
            planHash,
          })

          emit(
            outputOptions(options),
            approval,
            () =>
              `\n${bold('DSP APPROVE')}\n\n  ${green('✓')} ${approval.planId} approved by ${approval.approvedBy}\n` +
              `  Plan hash: ${approval.planHash}\n  Reason:    ${approval.reason}\n\n`,
          )
          return EXIT.ok
        }, options)
      },
    )

  program
    .command('apply')
    .argument('<plan-id>')
    .option('--confirm', 'actually execute the plan')
    .option('--idempotency-key <key>', 'idempotency key (defaults to a stable per-plan key)')
    .option('--if-match <revision>', 'only apply if the current state is still at this revision')
    .description('Execute a stored plan by id. Never accepts a document.')
    .action(
      async (
        planId: string,
        opts: { confirm?: boolean; idempotencyKey?: string; ifMatch?: string },
        command: Command,
      ) => {
        const options = command.optsWithGlobals<GlobalOptions>()
        await run(async () => {
          const client = clientFrom(options)

          if (opts.confirm !== true) {
            const plan = await client.getPlan(planId)
            emit(outputOptions(options), { plan, applied: false }, () => renderPlan(plan))
            warn(`nothing was applied. Re-run with ${bold('--confirm')} to execute ${planId}.`)
            return EXIT.notConfirmed
          }

          const operation = await client.apply(planId, {
            // A stable default key makes a repeated apply return the same
            // operation instead of duplicating external resources.
            idempotencyKey: opts.idempotencyKey ?? `dsp-cli:${planId}`,
            ...(opts.ifMatch === undefined ? {} : { ifMatch: opts.ifMatch }),
          })

          emit(outputOptions(options), operation, () => renderOperation(operation))

          if (operation.status === 'completed') return EXIT.ok
          // These all mean the same thing to a caller: what was wanted is not true.
          // `goal_not_satisfied` is the sharpest case — every change succeeded and
          // the point was still missed.
          if (
            operation.status === 'verification_failed' ||
            operation.status === 'partially_completed' ||
            operation.status === 'goal_not_satisfied'
          ) {
            return EXIT.notSatisfied
          }
          return EXIT.error
        }, options)
      },
    )

  program
    .command('status')
    .argument('<operation-id>')
    .description('Fetch an operation')
    .action(async (operationId: string, _opts: unknown, command: Command) => {
      const options = command.optsWithGlobals<GlobalOptions>()
      await run(async () => {
        const operation = await clientFrom(options).operation(operationId)
        emit(outputOptions(options), operation, () => renderOperation(operation, 'DSP STATUS'))
        return operation.status === 'completed' ? EXIT.ok : EXIT.error
      }, options)
    })

  program
    .command('verify')
    .argument('<operation-id>')
    .description('Re-read the provider state and compare it with the desired state')
    .action(async (operationId: string, _opts: unknown, command: Command) => {
      const options = command.optsWithGlobals<GlobalOptions>()
      await run(async () => {
        const result = await clientFrom(options).verify(operationId)
        emit(outputOptions(options), result, () => renderVerification(result))
        return result.status === 'satisfied' ? EXIT.ok : EXIT.notSatisfied
      }, options)
    })

  program
    .command('cancel')
    .argument('<operation-id>')
    .description('Request cancellation of a running operation')
    .action(async (operationId: string, _opts: unknown, command: Command) => {
      const options = command.optsWithGlobals<GlobalOptions>()
      await run(async () => {
        const operation = await clientFrom(options).cancel(operationId)
        emit(outputOptions(options), operation, () => renderOperation(operation, 'DSP CANCEL'))
        return EXIT.ok
      }, options)
    })

  const audit = program
    .command('audit')
    .option('--limit <n>', 'maximum number of events', (value: string) =>
      Number.parseInt(value, 10),
    )
    .option('--plan <planId>', 'only events for this plan')
    .option('--operation <operationId>', 'only events for this operation')
    .description('List audit events')
    .action(
      async (opts: { limit?: number; plan?: string; operation?: string }, command: Command) => {
        const options = command.optsWithGlobals<GlobalOptions>()
        await run(async () => {
          const result = await clientFrom(options).audit({
            ...(opts.limit === undefined ? {} : { limit: opts.limit }),
            ...(opts.plan === undefined ? {} : { planId: opts.plan }),
            ...(opts.operation === undefined ? {} : { operationId: opts.operation }),
          })
          emit(outputOptions(options), result, () => renderAudit(result.items))
          return EXIT.ok
        }, options)
      },
    )

  audit
    .command('verify')
    .description('Verify the integrity of the audit hash chain')
    .action(async (_opts: unknown, command: Command) => {
      const options = command.optsWithGlobals<GlobalOptions>()
      await run(async () => {
        const result = await clientFrom(options).verifyAuditChain()
        emit(outputOptions(options), result, () =>
          result.valid
            ? `\n${bold('DSP AUDIT VERIFY')}\n\n  ${green('✓')} chain intact across ${result.events} event(s)\n\n`
            : `\n${bold('DSP AUDIT VERIFY')}\n\n  ${red('✗')} chain broken at sequence ${String(
                result.brokenAt?.sequence,
              )}\n  ${yellow(String(result.brokenAt?.reason))}\n\n`,
        )
        return result.valid ? EXIT.ok : EXIT.auditChainBroken
      }, options)
    })

  return program
}
