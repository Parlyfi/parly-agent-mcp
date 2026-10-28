export type PublicApiAuth = {
  bearerToken?: string
}

export type PublicApiQuery = Record<string, string | number | boolean | null | undefined>

export type PrivacyLinkKind = "profile" | "invoice"
export type PublicPaymentContext = {
  linkKind?: PrivacyLinkKind
  slug?: string
}

/**
 * Requires the same owner wallet signature accepted by the Parly web app.
 * Create and edit both republish signed public metadata; this client cannot
 * bypass owner approval.
 */
export type PrivacyLinkPublishInput = {
  metadata: Record<string, unknown>
  message: string
  ownerWallet: `0x${string}`
  recipientRecoveryPublicKeyB64: string
  signature: `0x${string}`
  slug: string
}

export type CreateProfileLinkInput = PrivacyLinkPublishInput
export type EditProfileLinkInput = PrivacyLinkPublishInput
export type CreateInvoiceLinkInput = PrivacyLinkPublishInput
export type EditInvoiceLinkInput = PrivacyLinkPublishInput
export type PrivacyLinkOwnerSignedInput = {
  message: string
  ownerWallet: `0x${string}`
  signature: `0x${string}`
}
export type PrivacyLinkClaimInput = PrivacyLinkOwnerSignedInput & {
  kind: PrivacyLinkKind
  slug: string
}
export type PrivacyLinkVisibilityInput = PrivacyLinkOwnerSignedInput & {
  kind: PrivacyLinkKind
  slug: string
  status: "active" | "paused" | "deleted"
}

export type PublicApiResponse<T> = T & {
  ok?: boolean
  error?: string
}

export type BatchCsvRow = {
  destination: `0x${string}`
  amount: string
  asset: string
}

export type PayoutV5QuoteInput = {
  assetId: 1 | 2
  sourcePool: `0x${string}`
  destinationChainId: number
  destinationToken: `0x${string}`
  destinationRecipient: `0x${string}`
  amountOutBaseUnits: string
  refundWallet: `0x${string}`
  refundRecipientCommitment: `0x${string}`
  escrowSalt: `0x${string}`
}

export type PayoutV5QuoteAuthorization = {
  wallet: `0x${string}`
  issuedAt: number
  nonce: string
  signature: `0x${string}`
}

export type PayoutV5Quote = {
  quoteHash: `0x${string}`
  assetId: 1 | 2
  sourcePool: `0x${string}`
  sourceToken: `0x${string}`
  adapter: `0x${string}`
  withdrawalExecutor: `0x${string}`
  escrow: `0x${string}`
  escrowAmountBaseUnits: string
  executorFeeBaseUnits: string
  protocolFeeBaseUnits: string
  destinationChainId: number
  destinationToken: `0x${string}`
  destinationRecipient: `0x${string}`
  destinationAmountOutBaseUnits: string
  relaySourceAmountBaseUnits: string
  relayRouteCostBaseUnits: string
  submissionReimbursementBaseUnits: string
  deliverySuccessFeeBaseUnits: string
  maximumOperatorFeeBaseUnits: string
  primaryRefundToken: `0x${string}`
  secondaryRefundToken: `0x${string}`
  refundRecipientCommitment: `0x${string}`
  requestIdHash: `0x${string}`
  refundRouteBindingHash: `0x${string}`
  quoteExpiresAt: number
  preSubmissionRecoveryDelaySeconds: number
  maximumCompletionDelaySeconds: number
  totalNeededFromNoteBaseUnits: string
}

export type PayoutV5Acceptance = {
  payoutId: `phase3-payout-v5:${string}`
  intentHash: `0x${string}`
  statusAccessToken: string
  supportReference: string
  adapter: `0x${string}`
  withdrawalExecutor: `0x${string}`
  escrow: `0x${string}`
  escrowAmountBaseUnits: string
  executorFeeBaseUnits: string
  quoteExpiresAt: number
}

export type PayoutV5RecoveryAction =
  | "none"
  | "waiting"
  | "make_refund_available"
  | "claim_refund"
  | "refunded"

export type PayoutV5PublicStatus = {
  adapterVersion?: "v5"
  payoutId?: `phase3-payout-v5:${string}`
  status?: string
  statusLabel?: string
  progressStep?: number
  recoveryAction?: PayoutV5RecoveryAction
  recoveryAvailableAt?: number
  recoveryMatured?: boolean
  refundEligible?: boolean
  supportReference?: string
  lastCheckedAt?: string | null
  nextCheckAt?: string | null
  expectedDeliveryAt?: string | null
  [key: string]: unknown
}

export type PayoutV5UnsignedRefundCall = {
  to: `0x${string}`
  functionName: "makeEscrowRefundAvailableAfterDeadline" | "claimRefund"
  args: readonly [`0x${string}`] | readonly [`0x${string}`, `0x${string}`]
}

export type PayoutV6ChildQuoteInput = {
  destinationChainId: number
  destinationToken: `0x${string}`
  destinationRecipient: `0x${string}`
  amountOutBaseUnits: string
  refundWallet: `0x${string}`
  refundRecipientCommitment: `0x${string}`
  escrowSalt: `0x${string}`
}

export type PayoutV6QuoteInput = {
  assetId: 1 | 2
  sourcePool: `0x${string}`
  children: readonly PayoutV6ChildQuoteInput[]
}

export type PayoutV6ChildManifest = {
  intentHash: `0x${string}`
  escrow: `0x${string}`
  escrowAmountBaseUnits: string
  sourceExecutorFeeAllocationBaseUnits: string
  destinationChainId: number
  destinationToken: `0x${string}`
  destinationRecipient: `0x${string}`
  destinationAmountOutBaseUnits: string
  relaySourceAmountBaseUnits: string
  relayRouteCostBaseUnits: string
  submissionReimbursementBaseUnits: string
  deliverySuccessFeeBaseUnits: string
  refundRecipientCommitment: `0x${string}`
  requestIdHash: `0x${string}`
  refundRouteBindingHash: `0x${string}`
}

export type PayoutV6Manifest = {
  version: 6
  manifestHash: `0x${string}`
  clientAuthorizationId: `0x${string}`
  adapter: `0x${string}`
  withdrawalExecutor: `0x${string}`
  selectedRelayer: `0x${string}`
  relayerPublicKeyHash: `0x${string}`
  sourcePool: `0x${string}`
  sourceToken: `0x${string}`
  assetId: 1 | 2
  inputCount: 1 | 2 | 3 | 4
  sourceCallHash: `0x${string}`
  sealedExecutionPayloadHash: `0x${string}`
  protocolFeeBaseUnits: string
  sourceExecutorFeeBaseUnits: string
  totalDestinationAmountBaseUnits: string
  totalEscrowAmountBaseUnits: string
  maximumTotalNoteDeductionBaseUnits: string
  quoteExpiresAt: number
  preSubmissionRecoveryDelaySeconds: number
  children: readonly PayoutV6ChildManifest[]
}

export type PayoutV6PreparationInput = {
  quoteSessionId: string
  clientAuthorizationId: `0x${string}`
  inputCount: 1 | 2 | 3 | 4
  sourceCallHash: `0x${string}`
  sealedExecutionPayload: `0x${string}`
  selectedRelayer: `0x${string}`
  relayerPublicKeyHash: `0x${string}`
  protocolFeeBaseUnits: string
  sourceExecutorFeeBaseUnits: string
  sourceFeeAllocationsBaseUnits: readonly string[]
  maximumTotalNoteDeductionBaseUnits: string
  refundRecipientCommitments: readonly `0x${string}`[]
}

export type PayoutV6Authorization = PayoutV5QuoteAuthorization

export type PayoutV6Acceptance = {
  manifestHash: `0x${string}`
  batchGroupHash: `0x${string}`
  adapter: `0x${string}`
  withdrawalExecutor: `0x${string}`
  children: readonly PayoutV5Acceptance[]
}

export type PayoutV6RecoveryAction =
  | "none"
  | "waiting"
  | "claim_pre_submission_refund"
  | "claim_refund"
  | "refunded"

export type PayoutV6PublicStatus = PayoutV5PublicStatus & {
  adapterVersion?: "v6"
  recoveryAction?: PayoutV6RecoveryAction
  receiptAvailable?: boolean
}

export type PayoutV6UnsignedRefundCall = {
  to: `0x${string}`
  functionName: "claimPreSubmissionRefundAfterMaturity" | "claimRefund"
  args: readonly [`0x${string}`, `0x${string}`]
}

export class ParlyPublicApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: PublicApiAuth = {}
  ) {}

  status(query: { kind: PrivacyLinkKind; slug: string }) {
    return this.get<PublicApiResponse<{ available?: boolean; kind: PrivacyLinkKind; slug: string }>>(
      "/api/phase3/privacy-links/status",
      query
    )
  }

  checkPrivacyLinkStatus(query: { kind: PrivacyLinkKind; slug: string }) {
    return this.status(query)
  }

  claimPrivacyLinkName(input: PrivacyLinkClaimInput) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/phase3/privacy-links/claim", input)
  }

  listOwnedPrivacyLinks(input: PrivacyLinkOwnerSignedInput & { window?: "24h" | "7d" | "30d" }) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/phase3/privacy-links/owned", input)
  }

  updatePrivacyLinkVisibility(input: PrivacyLinkVisibilityInput) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/phase3/privacy-links/status", input)
  }

  reportPrivacyLink(body: Record<string, unknown>) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/phase3/privacy-links/report", body)
  }

  readPrivacyLinkSocialStatus(query: PublicApiQuery = {}) {
    return this.get<PublicApiResponse<Record<string, unknown>>>("/api/phase3/privacy-links/social-status", query)
  }

  createPrivacyImageUploadUrl(body: Record<string, unknown>) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/phase3/privacy-links/image-upload", body)
  }

  readProfileLink(slug: string) {
    return this.get<PublicApiResponse<Record<string, unknown>>>("/api/phase3/privacy-links/public", {
      kind: "profile",
      slug
    })
  }

  readInvoiceLink(slug: string) {
    return this.get<PublicApiResponse<Record<string, unknown>>>("/api/phase3/privacy-links/public", {
      kind: "invoice",
      slug
    })
  }

  createProfileLink(input: CreateProfileLinkInput) {
    return this.publishPrivacyLink("profile", input)
  }

  editProfileLink(input: EditProfileLinkInput) {
    return this.publishPrivacyLink("profile", input)
  }

  createInvoiceLink(input: CreateInvoiceLinkInput) {
    return this.publishPrivacyLink("invoice", input)
  }

  editInvoiceLink(input: EditInvoiceLinkInput) {
    return this.publishPrivacyLink("invoice", input)
  }

  createOneTimeDeposit(body: Record<string, unknown>) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/phase3/one-time-deposit", body)
  }

  createProfileOneTimeAddress(body: Record<string, unknown>) {
    return this.createOneTimeDeposit({ ...body, linkKind: "profile" satisfies PrivacyLinkKind })
  }

  createInvoiceOneTimeAddress(body: Record<string, unknown>) {
    return this.createOneTimeDeposit({ ...body, linkKind: "invoice" satisfies PrivacyLinkKind })
  }

  quoteWalletDeposit(body: Record<string, unknown>) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/phase3/wallet-deposit", body)
  }

  prepareProfilePayment(body: Record<string, unknown>) {
    return this.quoteWalletDeposit({ ...body, linkKind: "profile" satisfies PrivacyLinkKind })
  }

  prepareInvoicePayment(body: Record<string, unknown>) {
    return this.quoteWalletDeposit({ ...body, linkKind: "invoice" satisfies PrivacyLinkKind })
  }

  verifyInvoiceReceipt(body: { token: string }) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/verify/invoice", body)
  }

  verifyPayoutScope(body: { childKey: string; txHash: `0x${string}` }) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/verify/payout", body)
  }

  receiptDownloadUrl(body: { statusAccessToken: string }) {
    return this.post<PublicApiResponse<{ available: boolean; url?: string }>>(
      "/api/phase3/receipt-download",
      body
    )
  }

  createReceiptDownloadUrl(body: { statusAccessToken: string }) {
    return this.receiptDownloadUrl(body)
  }

  readPaymentStatus(body: { statusAccessToken: string }) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/phase3/payment-status", body)
  }

  readPayoutStatus(body: { statusAccessToken: string }) {
    return this.post<PublicApiResponse<PayoutV5PublicStatus>>("/api/phase3/payout-status", body)
  }

  quoteCrossChainPayout(body: PayoutV5QuoteInput) {
    return this.post<PublicApiResponse<{ quote: PayoutV5Quote }>>("/api/phase3/payout-v5/quote", body)
  }

  quoteCrossChainPayoutV6(body: PayoutV6QuoteInput) {
    return this.post<PublicApiResponse<{ quoteSessionId: string; quote: Record<string, unknown> }>>(
      "/api/phase3/payout-v6/quote",
      body
    )
  }

  prepareCrossChainPayoutV6(body: PayoutV6PreparationInput) {
    return this.post<PublicApiResponse<{ manifest: PayoutV6Manifest }>>(
      "/api/phase3/payout-v6/preparation",
      body
    )
  }

  authorizeCrossChainPayoutV6(body: {
    manifestHash: `0x${string}`
    authorization: PayoutV6Authorization
  }) {
    return this.post<PublicApiResponse<{ payout: PayoutV6Acceptance }>>(
      "/api/phase3/payout-v6/accept",
      body
    )
  }

  authorizeCrossChainPayoutV6Batch(body: {
    manifestHash: `0x${string}`
    authorization: PayoutV6Authorization
  }) {
    return this.post<PublicApiResponse<{ payout: PayoutV6Acceptance }>>(
      "/api/phase3/payout-v6/batch/accept",
      body
    )
  }

  readPayoutV6Status(body: { statusAccessToken: string }) {
    return this.post<PublicApiResponse<PayoutV6PublicStatus>>("/api/phase3/payout-v6/status", body)
  }

  storePayoutV6RecoveryCapsule(body: {
    statusAccessToken: string
    recoveryKeyHash: string
    sealedPayload: `0x${string}`
  }) {
    return this.postWithBearer<PublicApiResponse<{ ok: true }>>(
      "/api/phase3/payout-v6/recovery",
      body.statusAccessToken,
      { recoveryKeyHash: body.recoveryKeyHash, sealedPayload: body.sealedPayload }
    )
  }

  preparePayoutV6RefundCall(input: {
    adapter: `0x${string}`
    intentHash: `0x${string}`
    refundSalt: `0x${string}`
    recoveryAction: PayoutV6RecoveryAction
  }): PayoutV6UnsignedRefundCall[] {
    if (input.recoveryAction !== "claim_pre_submission_refund" && input.recoveryAction !== "claim_refund") return []
    return [{
      to: input.adapter,
      functionName: input.recoveryAction === "claim_pre_submission_refund"
        ? "claimPreSubmissionRefundAfterMaturity"
        : "claimRefund",
      args: [input.intentHash, input.refundSalt]
    }]
  }

  authorizeCrossChainPayout(body: { quoteHash: `0x${string}`; authorization: PayoutV5QuoteAuthorization }) {
    return this.post<PublicApiResponse<{ payout: PayoutV5Acceptance }>>("/api/phase3/payout-v5/accept", body)
  }

  attachCrossChainPayoutProof(body: { statusAccessToken: string; payload: Record<string, unknown> }) {
    return this.postWithBearer<PublicApiResponse<{ ok: true }>>(
      "/api/phase3/payout-v5/preparation",
      body.statusAccessToken,
      { payload: body.payload }
    )
  }

  storePayoutRecoveryCapsule(body: {
    statusAccessToken: string
    adapterVersion: "v5"
    recoveryKeyHash: string
    sealedPayload: `0x${string}`
  }) {
    return this.postWithBearer<PublicApiResponse<{ ok: true }>>(
      "/api/phase3/payout-recovery",
      body.statusAccessToken,
      {
        adapterVersion: body.adapterVersion,
        recoveryKeyHash: body.recoveryKeyHash,
        sealedPayload: body.sealedPayload
      }
    )
  }

  readCrossChainPayoutReceipt(body: { statusAccessToken: string }) {
    return this.post<PublicApiResponse<{ manifest: Record<string, unknown> }>>("/api/phase3/payout-receipt", body)
  }

  preparePayoutV5RefundCalls(input: {
    adapter: `0x${string}`
    intentHash: `0x${string}`
    refundSalt: `0x${string}`
    recoveryAction: PayoutV5RecoveryAction
  }): PayoutV5UnsignedRefundCall[] {
    if (input.recoveryAction === "refunded" || input.recoveryAction === "none" || input.recoveryAction === "waiting") return []
    const claim: PayoutV5UnsignedRefundCall = {
      to: input.adapter,
      functionName: "claimRefund",
      args: [input.intentHash, input.refundSalt]
    }
    return input.recoveryAction === "make_refund_available"
      ? [{ to: input.adapter, functionName: "makeEscrowRefundAvailableAfterDeadline", args: [input.intentHash] }, claim]
      : [claim]
  }

  readPayerHistory(body: Record<string, unknown>) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/phase3/payer-history", body)
  }

  claimRefund(body: Record<string, unknown>) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/phase3/refund-claim", body)
  }

  readUiSettings() {
    return this.get<PublicApiResponse<Record<string, unknown>>>("/api/phase3/ui-settings")
  }

  listRelayers(query: PublicApiQuery = {}) {
    return this.get<PublicApiResponse<Record<string, unknown>>>("/api/relayers", query)
  }

  startRelayerRegistration(body: Record<string, unknown>) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/relayers/register/init", body)
  }

  confirmRelayerRegistration(body: Record<string, unknown>) {
    return this.post<PublicApiResponse<Record<string, unknown>>>("/api/relayers/register/confirm", body)
  }

  parseBatchCsv(csv: string): BatchCsvRow[] {
    const rows = csv
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)

    const dataRows = rows[0]?.toLowerCase().includes("destination") ? rows.slice(1) : rows
    if (dataRows.length < 1 || dataRows.length > 10) {
      throw new Error("Batch CSV must contain 1 to 10 payment rows.")
    }

    return dataRows.map((row, index) => {
      const [destination = "", amount = "", asset = ""] = row.split(",").map((value) => value.trim())
      if (!/^0x[a-fA-F0-9]{40}$/u.test(destination)) {
        throw new Error(`Batch CSV row ${index + 1} has an invalid destination.`)
      }
      if (!/^\d+(\.\d{1,6})?$/u.test(amount) || Number(amount) <= 0) {
        throw new Error(`Batch CSV row ${index + 1} has an invalid amount.`)
      }
      if (!/^(USDC|USDC\.e|USDT|USDT0)$/u.test(asset)) {
        throw new Error(`Batch CSV row ${index + 1} has an unsupported asset.`)
      }
      return { destination: destination as `0x${string}`, amount, asset }
    })
  }

  private publishPrivacyLink(kind: PrivacyLinkKind, input: PrivacyLinkPublishInput) {
    return this.post<PublicApiResponse<{ kind: PrivacyLinkKind; metadata: Record<string, unknown>; slug: string; status: string }>>(
      "/api/phase3/privacy-links/publish",
      {
        ...input,
        kind
      }
    )
  }

  private async get<T>(path: string, query: PublicApiQuery = {}) {
    const url = new URL(path, this.baseUrl)
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value))
    }
    return this.request<T>("GET", url)
  }

  private async post<T>(path: string, body: unknown = {}) {
    return this.request<T>("POST", new URL(path, this.baseUrl), body)
  }

  private async postWithBearer<T>(path: string, bearerToken: string, body: unknown = {}) {
    return this.request<T>("POST", new URL(path, this.baseUrl), body, bearerToken)
  }

  private async request<T>(method: "GET" | "POST", url: URL, body?: unknown, bearerToken?: string): Promise<T> {
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(bearerToken || this.auth.bearerToken
          ? { authorization: `Bearer ${bearerToken || this.auth.bearerToken}` }
          : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload
          ? String(payload.error)
          : `Parly API request failed with HTTP ${response.status}.`
      throw new Error(message)
    }
    return payload as T
  }
}
