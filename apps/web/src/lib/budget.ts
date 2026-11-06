import type { CallRecord, GenerationRecord, StudioOperation, Reservation } from '../types.ts';
type BudgetRecord = Pick<CallRecord | GenerationRecord | StudioOperation, 'currency' | 'reservedAmount' | 'actualAmount' | 'status'>;
export function budgetUsed(records: BudgetRecord[], currency: Reservation['currency']): number {
  return Math.round(records.filter(record => record.currency === currency).reduce((sum, record) => sum + (record.actualAmount ?? record.reservedAmount), 0) * 10000) / 10000;
}
export function unknownReservations(records: BudgetRecord[]): number { return records.filter(record => record.status === 'submission_unknown' && record.actualAmount === null).length; }
export function reservationValid(reservation: Reservation, used: number): boolean {
  return [reservation.amount, reservation.singleLimit, reservation.projectLimit].every(value => Number.isFinite(value) && value >= 0)
    && reservation.amount <= reservation.singleLimit && Math.round((used + reservation.amount) * 10000) <= Math.round(reservation.projectLimit * 10000);
}
