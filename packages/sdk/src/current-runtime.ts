import type { Address, Hex } from "viem"
import type { ReceivingProverV4 } from "./current-prover-v4.js"

export type PoolV4Wallet = {
  request(request: { method: string; params?: unknown[] }): Promise<unknown>
  sendTransaction(transaction: { account: Address; to: Address; data: Hex; value: bigint }): Promise<Hex>
}
export type PoolV4RelayBundle = { version: 2; launchScope: "phase3-mainnet"; relayerAddress: Address; ciphertext: Hex }
export type PoolV4Runtime = {
  origin: string
  prove: ReceivingProverV4
  wallet?: PoolV4Wallet
  fetcher: typeof fetch
  relayRewardPolicyEnv: Record<string, string | undefined>
  sealRelay(publicKeyB64: string, payload: unknown): Promise<Hex>
  sealRecovery(publicKeyB64: string, payload: unknown): Promise<Hex>
  openRecovery<T>(publicKeyB64: string, privateKeyB64: string, sealed: Hex): Promise<T>
  relay?: {
    buildBundleKey(bundle: PoolV4RelayBundle): Promise<string>
    createStatusToken(): string
    publish(bundle: PoolV4RelayBundle, options: { requireInbox: boolean; recovery: { statusAccessToken: string; recoveryKeyHash: string; sealedPayload: Hex } }): Promise<{ bundleKey: string; statusAccessToken?: string }>
  }
}
export type PayoutV7Runtime = PoolV4Runtime & {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">
  pins: { adapter: Address; executor: Address; adapterHash: Hex; executorHash: Hex }
  signMessage(args: { account: Address; message: string }): Promise<Hex>
}
