export type CallStatus = 'queued' | 'submitting' | 'submission_unknown' | 'succeeded' | 'failed';
export interface Reservation { currency: 'USD' | 'CNY'; amount: number; singleLimit: number; projectLimit: number }
export interface CallRecord {
  id: string; projectId: string; providerId: string; jobId: string; status: CallStatus;
  currency: Reservation['currency']; reservedAmount: number; actualAmount: number | null;
  /** No local reservation was configured; supplier charges remain unknown. */
  budgetMode?: 'none';
  draftId: string | null; error: { code: string; message: string } | null;
  createdAt: string; updatedAt: string;
}
