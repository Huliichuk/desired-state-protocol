import type { JsonSchema } from './common.js'

/**
 * A single normalized resource. Both the desired and the current side of a diff
 * are expressed as a flat set of these, which is what makes the DSP diff
 * generic and provider-independent.
 */
export interface ResourceInstance<
  TAttributes extends Record<string, unknown> = Record<string, unknown>,
> {
  resourceType: string
  /** Stable identity of the resource inside the document. */
  key: string
  attributes: TAttributes
  /** Keys of resources that MUST exist before this one is applied. */
  dependsOn?: string[]
  /** Identifier in the external system, when the resource already exists. */
  externalId?: string | null
}

export interface ResourceProjection {
  resources: ResourceInstance[]
}

export interface ResourceCapabilities {
  inspect: boolean
  plan: boolean
  apply: boolean
  verify: boolean
  delete: boolean
}

/**
 * Static properties of a resource type that feed the deterministic risk score.
 */
export interface ResourceRiskFactors {
  /** Changes to this resource move money or change what a customer is billed. */
  financial?: boolean
  /** Changes are visible outside the organization (public pages, emails, webhooks). */
  externallyVisible?: boolean
  /** The resource grants or widens permissions. */
  permissionScope?: boolean
  /** The resource itself is sensitive even when no sensitive field changes. */
  sensitive?: boolean
}

/**
 * Describes a leaf resource type such as `mock.database` or `stripe.product`.
 */
export interface ResourceTypeDefinition {
  /** Fully qualified name, e.g. `stripe.product`. */
  name: string
  provider: string
  description?: string
  capabilities: ResourceCapabilities
  /** Attribute paths forming the resource identity. */
  identityFields: string[]
  /** Attribute paths that force a replace when changed. */
  immutableFields: string[]
  /** Attribute paths that MUST be redacted in plans, logs and API responses. */
  sensitiveFields: string[]
  /** JSON Schema describing `ResourceInstance.attributes`. */
  attributeSchema: JsonSchema
  riskFactors?: ResourceRiskFactors
}

/**
 * Describes a Desired State document kind such as `MockWorkspace`.
 */
export interface KindDefinition {
  kind: string
  provider: string
  description?: string
  /** JSON Schema describing `DesiredStateDocument.spec`. */
  specSchema: JsonSchema
  /** Resource types this kind can project into. */
  resourceTypes: string[]
}
