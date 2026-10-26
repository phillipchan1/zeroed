/** Tool / protocol errors that are safe to show the caller. Everything else is generic. */
export class McpUserError extends Error {
  readonly expose = true as const

  constructor(message: string) {
    super(message)
    this.name = 'McpUserError'
  }
}

export function isMcpUserError(err: unknown): err is McpUserError {
  return err instanceof McpUserError || (
    typeof err === 'object'
    && err !== null
    && (err as { expose?: unknown }).expose === true
    && typeof (err as { message?: unknown }).message === 'string'
  )
}
