/**
 * The DSP API version used by every protocol document.
 */
export const DSP_API_VERSION = 'dsp.dev/v1alpha1'

/**
 * The wire-protocol version advertised in the DSP manifest.
 * Independent of package versions: it changes only when the protocol changes.
 */
export const DSP_PROTOCOL_VERSION = '0.1.0'

export type DspApiVersion = typeof DSP_API_VERSION
