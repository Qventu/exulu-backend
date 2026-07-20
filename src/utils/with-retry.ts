// Helper function to retry generateText calls
export async function withRetry<T>(
    generateFn: () => Promise<T>,
    maxRetries: number = 3,
    opts: {
      /** Return false to rethrow immediately (deterministic failures gain nothing from retries). */
      shouldRetry?: (error: unknown) => boolean;
      baseDelayMs?: number;
    } = {},
  ): Promise<T> {
    const { shouldRetry, baseDelayMs = 1000 } = opts;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await generateFn();
      } catch (error) {
        lastError = error;
        console.error(`[EXULU] generateText attempt ${attempt} failed:`, error);

        if (attempt === maxRetries || (shouldRetry && !shouldRetry(error))) {
          throw error;
        }

        // Wait before retrying (exponential backoff)
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * baseDelayMs));
      }
    }

    // This should never be reached, but TypeScript needs it
    throw lastError;
  }
