import { DSP_API_VERSION, type DesiredStateDocument } from '@dsp/protocol'
import { runProviderConformanceSuite } from '@dsp/provider-sdk/conformance'
import { MockBackend, MockProvider, type MockWorkspaceSpec } from '@dsp/provider-mock'

const baseSpec: MockWorkspaceSpec = {
  databases: [
    {
      name: 'main',
      engine: 'postgres',
      region: 'eu-central-1',
      tables: [{ name: 'users', columns: [{ name: 'id', type: 'text' }] }],
    },
  ],
  users: [{ email: 'founder@example.com', role: 'admin' }],
  subscriptions: [{ user: 'founder@example.com', plan: 'pro', amountCents: 2900, currency: 'eur' }],
}

function document(spec: MockWorkspaceSpec): DesiredStateDocument<MockWorkspaceSpec> {
  return {
    apiVersion: DSP_API_VERSION,
    kind: 'MockWorkspace',
    metadata: { name: 'conformance' },
    spec,
  }
}

// The reference provider must pass the same suite every third-party provider does.
runProviderConformanceSuite<MockWorkspaceSpec, { resources: [] }>({
  name: 'mock',
  createProvider: () => new MockProvider({ backend: new MockBackend(':memory:') }) as never,
  validDocument: () => document(baseSpec),
  documentWithResourceRemoved: () =>
    document({
      ...baseSpec,
      // The subscription disappears from the document, so the runtime would have
      // to delete it — which the mock resource type does not allow.
      subscriptions: [],
    }),
  reset: (provider) => {
    ;(provider as unknown as MockProvider).backend.close()
  },
})
