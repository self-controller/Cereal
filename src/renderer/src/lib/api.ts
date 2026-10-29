import { useEffect, useRef } from 'react'
import type { EventChannel, EventMap, InvokeChannel, InvokeMap } from '@shared/ipc'

/** Call the main process. Errors are re-thrown with Electron's "Error invoking remote method" prefix removed. */
export async function call<K extends InvokeChannel>(channel: K, ...args: Parameters<InvokeMap[K]>): Promise<Awaited<ReturnType<InvokeMap[K]>>> {
  try {
    return await window.cereal.invoke(channel, ...args)
  } catch (e) {
    const message = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    throw new Error(message)
  }
}

/** Subscribe to a main → renderer event for the lifetime of the component. */
export function useEvent<K extends EventChannel>(channel: K, listener: (payload: EventMap[K]) => void): void {
  const ref = useRef(listener)
  ref.current = listener
  useEffect(() => {
    const off = window.cereal.on(channel, (payload) => ref.current(payload))
    return () => {
      off()
    }
  }, [channel])
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
