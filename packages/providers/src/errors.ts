import { AppError } from '../../contracts/src/errors.ts';
import type { ProviderFailureClassification } from '../../contracts/src/providers.ts';

/** Only safe classification/status metadata is retained, never the supplier body. */
export class ProviderCallError extends AppError {
  readonly classification: ProviderFailureClassification;
  readonly httpStatus?: number;
  constructor(classification: ProviderFailureClassification, code: string, message: string, status = 502, httpStatus?: number) {
    super(code, message, status, { classification, ...(httpStatus === undefined ? {} : { httpStatus }) });
    this.classification = classification;
    this.httpStatus = httpStatus;
  }
}
export function invalidResponse(code = 'PROVIDER_INVALID_RESPONSE'): ProviderCallError {
  return new ProviderCallError('invalid_response', code, '模型响应未通过结构校验，未修改项目；不会自动再次调用。');
}
