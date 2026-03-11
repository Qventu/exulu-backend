export interface RateLimiterRule {
    name?: string; // optional, if not provided the rate limiter uses the agent id for the queue name
    rate_limit: {
      time: number; // time until usage expires in seconds
      limit: number;
    };
  }