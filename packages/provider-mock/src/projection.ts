import type { ResourceInstance, ResourceProjection } from '@dsp/protocol'
import { MOCK_RESOURCE_TYPES, type MockWorkspaceSpec, type StoredResource } from './types.js'

export function databaseKey(name: string): string {
  return `${MOCK_RESOURCE_TYPES.database}/${name}`
}

export function tableKey(database: string, name: string): string {
  return `${MOCK_RESOURCE_TYPES.table}/${database}.${name}`
}

export function userKey(email: string): string {
  return `${MOCK_RESOURCE_TYPES.user}/${email}`
}

export function subscriptionKey(user: string): string {
  return `${MOCK_RESOURCE_TYPES.subscription}/${user}`
}

/**
 * Projects a MockWorkspace spec into the flat resource set the DSP diff works
 * on. Nesting in the document becomes an explicit `dependsOn` edge, which is
 * how the runtime knows a table cannot be created before its database.
 */
export function projectSpec(spec: MockWorkspaceSpec): ResourceProjection {
  const resources: ResourceInstance[] = []

  for (const database of spec.databases ?? []) {
    resources.push({
      resourceType: MOCK_RESOURCE_TYPES.database,
      key: databaseKey(database.name),
      attributes: compact({
        name: database.name,
        engine: database.engine,
        region: database.region,
        sizeGb: database.sizeGb,
      }),
    })

    for (const table of database.tables ?? []) {
      resources.push({
        resourceType: MOCK_RESOURCE_TYPES.table,
        key: tableKey(database.name, table.name),
        dependsOn: [databaseKey(database.name)],
        attributes: compact({
          database: database.name,
          name: table.name,
          rowLimit: table.rowLimit,
          columns: table.columns.map((column) =>
            compact({
              name: column.name,
              type: column.type,
              nullable: column.nullable ?? false,
            }),
          ),
        }),
      })
    }
  }

  for (const user of spec.users ?? []) {
    resources.push({
      resourceType: MOCK_RESOURCE_TYPES.user,
      key: userKey(user.email),
      attributes: compact({
        email: user.email,
        role: user.role,
        displayName: user.displayName,
        apiToken: user.apiToken,
      }),
    })
  }

  for (const subscription of spec.subscriptions ?? []) {
    resources.push({
      resourceType: MOCK_RESOURCE_TYPES.subscription,
      key: subscriptionKey(subscription.user),
      dependsOn: [userKey(subscription.user)],
      attributes: compact({
        user: subscription.user,
        plan: subscription.plan,
        amountCents: subscription.amountCents,
        currency: subscription.currency,
        active: subscription.active ?? true,
      }),
    })
  }

  return { resources }
}

export function projectStored(resources: readonly StoredResource[]): ResourceProjection {
  return {
    resources: resources.map((resource) => ({
      resourceType: resource.resourceType,
      key: resource.key,
      attributes: resource.attributes,
      externalId: resource.externalId,
    })),
  }
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}
