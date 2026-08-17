/**
 * Shared error types and classification.
 * Based on Section 19 of the Technical Specification.
 */

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly severity: ErrorSeverity,
    public readonly retryable: boolean = false,
    public readonly userMessage?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class VlmError extends AppError {
  constructor(message: string, code: string, retryable = false) {
    super(message, code, 'medium', retryable, 'Analysis service temporarily unavailable.');
    this.name = 'VlmError';
  }
}

export class StorageError extends AppError {
  constructor(message: string, code: string) {
    super(message, code, 'high', false, 'Storage operation failed.');
    this.name = 'StorageError';
  }
}

export class SubscriptionError extends AppError {
  constructor(message: string, code: string) {
    super(message, code, 'low', false, 'Subscription limit reached.');
    this.name = 'SubscriptionError';
  }
}

export class DetectionError extends AppError {
  constructor(message: string, code: string) {
    super(message, code, 'medium', true, 'Detection pipeline error.');
    this.name = 'DetectionError';
  }
}

export class AuthError extends AppError {
  constructor(message: string, code: string) {
    super(message, code, 'medium', false, 'Authentication failed.');
    this.name = 'AuthError';
  }
}

// VLM error codes
export const VLM_ERROR_CODES = {
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  SERVER_ERROR: 'SERVER_ERROR',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  MAX_RETRIES: 'MAX_RETRIES',
  FILE_PROCESSING_FAILED: 'FILE_PROCESSING_FAILED',
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  PARSE_ERROR: 'PARSE_ERROR',
} as const;

export type VlmErrorCode = (typeof VLM_ERROR_CODES)[keyof typeof VLM_ERROR_CODES];
