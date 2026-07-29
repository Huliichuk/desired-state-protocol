import { DSPError, redactSensitiveData } from '@dsp/protocol'
import { bootstrap } from './bootstrap.js'
import { readServerEnv } from './env.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  const env = readServerEnv()
  const { runtime, close, policyBundle } = await bootstrap(env)
  const app = await createServer({
    runtime,
    authToken: env.authToken,
    logLevel: env.logLevel,
    pretty: env.pretty,
  })

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down')
    await app.close()
    close()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ host: env.host, port: env.port })

  app.log.info(
    {
      environment: env.environment,
      tenant: env.tenant,
      policies: policyBundle.policies.map((policy) => policy.metadata.name),
      policyBundleHash: runtime.policyBundleHash(),
      destructiveChanges: env.allowDestructive,
    },
    'DSP runtime ready',
  )

  if (env.authTokenGenerated) {
    // Printed to stdout rather than logged, so it is easy to copy and hard to
    // ship into a log aggregator by accident.
    process.stdout.write(
      `\nNo DSP_AUTH_TOKEN was set. Generated a token for this process only:\n\n  ${env.authToken}\n\n` +
        `Use it as:  dsp --server http://${env.host}:${env.port} --token ${env.authToken} discover\n\n`,
    )
  }
}

try {
  await main()
} catch (error) {
  // Startup diagnostics go to an operator's stderr, not to an untrusted client, so
  // the real cause is printed. Generic messages belong in HTTP responses; a
  // process that will not start has to be debuggable.
  process.stderr.write(`DSP server failed to start.\n\n`)

  if (DSPError.isDSPError(error)) {
    process.stderr.write(`  ${error.code}: ${error.message}\n`)
    if (error.details !== undefined) {
      process.stderr.write(`  ${JSON.stringify(redactSensitiveData(error.details))}\n`)
    }
  } else if (error instanceof Error) {
    process.stderr.write(`  ${error.name}: ${error.message}\n`)
    if (error.stack !== undefined) process.stderr.write(`\n${error.stack}\n`)
    if (error.cause !== undefined) {
      process.stderr.write(`\n  caused by: ${String(error.cause)}\n`)
    }
  } else {
    process.stderr.write(`  ${String(error)}\n`)
  }

  process.stderr.write('\n')
  process.exitCode = 1
}
