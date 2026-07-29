import { DSP_API_VERSION, type PolicyBundle, type PolicyDocument } from '@dsp/protocol'

/**
 * The policy every DSP runtime ships with. It encodes the MVP's safety posture:
 * nothing destructive runs, and anything risky needs a human.
 */
export const BASELINE_SAFETY_POLICY: PolicyDocument = {
  apiVersion: DSP_API_VERSION,
  kind: 'Policy',
  metadata: {
    name: 'baseline-safety',
    description: 'Default DSP safety rules: no destructive changes, approval for risky plans',
  },
  spec: {
    rules: [
      {
        id: 'block-delete',
        description: 'Deletions are never executed by this runtime',
        when: { action: 'delete' },
        effect: 'deny',
        message: 'Destructive operations are disabled',
      },
      {
        id: 'block-replace',
        description: 'A replace destroys and recreates a resource',
        when: { action: 'replace' },
        effect: 'deny',
        message: 'Replacing resources is disabled because it destroys existing state',
      },
      {
        id: 'require-approval-for-high-risk',
        description: 'High and critical risk changes need an explicit human approval',
        when: { riskIn: ['high', 'critical'] },
        effect: 'requireApproval',
        message: 'High risk changes require approval before apply',
        minApprovals: 1,
      },
      {
        id: 'warn-on-medium-risk',
        when: { riskIn: ['medium'] },
        effect: 'warn',
        message: 'Plan contains medium risk changes; review the diff before applying',
      },
      {
        id: 'limit-plan-size',
        description: 'A single apply should not rewrite an entire account',
        constraints: { maxTotalChanges: 100 },
        effect: 'deny',
        message: 'Plan exceeds the maximum number of changes allowed in one apply',
      },
    ],
  },
}

/**
 * Additional rules for production environments.
 */
export const PRODUCTION_SAFETY_POLICY: PolicyDocument = {
  apiVersion: DSP_API_VERSION,
  kind: 'Policy',
  metadata: {
    name: 'production-safety',
    description: 'Extra guardrails that only apply to the production environment',
  },
  spec: {
    rules: [
      {
        id: 'require-approval-in-production',
        when: { environment: 'production' },
        effect: 'requireApproval',
        message: 'Every change in production requires approval',
        minApprovals: 1,
      },
    ],
  },
}

export function defaultPolicyBundle(): PolicyBundle {
  return { policies: [BASELINE_SAFETY_POLICY, PRODUCTION_SAFETY_POLICY] }
}

export const EMPTY_POLICY_BUNDLE: PolicyBundle = { policies: [] }
