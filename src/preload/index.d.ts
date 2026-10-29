import type { CerealBridge } from '@shared/ipc'

declare global {
  interface Window {
    cereal: CerealBridge
  }
}

export {}
