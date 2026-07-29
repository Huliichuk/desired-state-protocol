export interface CurrentState<TState = unknown> {
  resourceType: string
  resourceId: string | null
  /** RFC 3339 timestamp of the observation. */
  observedAt: string
  /**
   * Opaque revision used for optimistic concurrency control. Providers may use
   * an ETag, a database version, or a hash of the normalized state.
   */
  revision?: string
  state: TState | null
}
