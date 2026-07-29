import type { DspApiVersion } from '../version.js'
import type { DesiredStateContract } from './contract.js'

/**
 * A reference to a secret held by the runtime. Desired State documents carry
 * references only: raw credentials MUST never appear in a DSP document.
 */
export interface SecretReference {
  name: string
  key?: string
  version?: string
}

export interface SecretRefHolder {
  secretRef: SecretReference
}

export interface DesiredStateMetadata {
  name: string
  namespace?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  requestId?: string
}

export interface DesiredStateDocument<TSpec = unknown> {
  apiVersion: DspApiVersion
  kind: string
  metadata: DesiredStateMetadata
  /**
   * What the document is for. Protocol machinery rather than provider data, so it
   * sits beside `spec` instead of inside it: every provider gets it for free and
   * none of them has to model it.
   */
  contract?: DesiredStateContract
  spec: TSpec
}

export const DEFAULT_NAMESPACE = 'default'

export function documentNamespace(document: DesiredStateDocument): string {
  return document.metadata.namespace ?? DEFAULT_NAMESPACE
}

/**
 * Stable identity of a Desired State document within a runtime.
 */
export function documentIdentity(document: DesiredStateDocument): string {
  return `${document.kind}/${documentNamespace(document)}/${document.metadata.name}`
}
