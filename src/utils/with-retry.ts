// Helper function to retry generateText calls
export async function withRetry<T>(generateFn: () => Promise<T>, maxRetries: number = 3): Promise<T> {
    let lastError: unknown;
  
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await generateFn();
      } catch (error) {
        lastError = error;
        console.error(`[EXULU] generateText attempt ${attempt} failed:`, error);
  
        if (attempt === maxRetries) {
          // Final attempt failed, throw the error
          throw error;
        }
  
        // Wait before retrying (exponential backoff)
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  
    // This should never be reached, but TypeScript needs it
    throw lastError;
  }