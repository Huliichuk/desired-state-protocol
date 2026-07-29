export interface DSPManifestEndpoints {
  resourceTypes: string
  kinds: string
  inspect: string
  validate: string
  plan: string
  approve: string
  apply: string
  verify: string
  operations: string
  audit: string
}

export interface DSPManifestFeatures {
  planBeforeApply: boolean
  signedPlans: boolean
  idempotency: boolean
  verification: boolean
  auditLog: boolean
  policyEvaluation: boolean
  destructiveChanges: boolean
  driftDetection: boolean
}

export interface DSPManifest {
  protocol: 'dsp'
  protocolVersion: string
  server: {
    name: string
    version: string
  }
  endpoints: DSPManifestEndpoints
  features: DSPManifestFeatures
  authentication: string[]
  limits: {
    maxDocumentBytes: number
    maxDocumentDepth: number
    maxResources: number
    maxChanges: number
    planTtlSeconds: number
  }
}
