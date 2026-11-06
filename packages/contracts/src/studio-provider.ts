/** The speech adapter always requests a complete WAV response. */
export interface SpeechInput {
  text: string;
  voice: string;
  speed: number;
  instructions: string | null;
}
export interface SpeechResult { bytes: Uint8Array; mime: 'audio/wav' }
export interface ReviewFrame {
  id: string;
  requestedTimeMs: number;
  sha256: string;
  width: number;
  height: number;
  mime: 'image/png';
}
export interface FrameReviewInput {
  expected: { purpose: string; description: string; action: string };
  frames: Array<ReviewFrame & { dataUrl: string }>;
  signal?: AbortSignal;
}
/** A verdict concerns only the supplied frames; coverage is assigned by the host. */
export interface FrameReviewResult {
  summary: string;
  sampledVerdict: 'pass' | 'needs_review' | 'reject';
  issues: Array<{
    category: 'subject' | 'composition' | 'visible_text' | 'consistency';
    severity: 'info' | 'warning' | 'error';
    frameIds: string[];
    observation: string;
  }>;
  uncertainties: string[];
}
