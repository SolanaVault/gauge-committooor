export const MAX_TRANSACTION_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 5_000;

export const isRetryableTransactionError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return ["timeout", "blockhash not found", "block height exceeded"].some(
    (condition) => normalized.includes(condition),
  );
};

type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (error: unknown, nextAttempt: number, delayMs: number) => void;
};

export const retryTransaction = async <T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? MAX_TRANSACTION_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? RETRY_BASE_DELAY_MS;
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableTransactionError(error)) {
        throw error;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }
  throw new Error("Transaction retry loop ended unexpectedly");
};
