import { ExuluTool } from "@SRC/exulu/tool";
import z from "zod";
import Perplexity from "@perplexity-ai/perplexity_ai";

const internetSearchTool = new ExuluTool({
  id: "internet_search",
  name: "Perplexity Live Internet Search",
  description: "Search the internet for information.",
  inputSchema: z.object({
    query: z.string().describe("The query to the tool."),
    search_recency_filter: z
      .enum(["day", "week", "month", "year"])
      .optional()
      .describe("The recency filter for the search, can be day, week, month or year."),
  }),
  category: "internet_search",
  type: "web_search",
  config: [
    {
      name: "perplexity_api_key",
      description: "The API key for the Perplexity API.",
      type: "variable",
      default: "",
    },
    {
      name: "search_domain_filter",
      description: "Comma seperated domain filter for the search.",
      type: "string",
      default: "",
    },
  ],
  execute: async ({ query, search_recency_filter, toolVariablesConfig }: any) => {
    const { perplexity_api_key: apiKey, search_domain_filter } = toolVariablesConfig;

    let domainFilterArray: string[] = [];

    if (search_domain_filter) {
      domainFilterArray = search_domain_filter.split(",").map((domain) => domain.trim());
    }

    const maxRetries: number = 3;

    if (!apiKey) {
      throw new Error("Perplexity API key is required.");
    }

    const client = new Perplexity({
      apiKey: apiKey,
    });

    let recency_filter: "hour" | "day" | "week" | "month" | "year" | undefined = undefined;
    if (search_recency_filter && ["day", "week", "month", "year"].includes(search_recency_filter)) {
      recency_filter = search_recency_filter;
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await client.chat.completions.create({
          messages: [
            {
              role: "user",
              content: `${query}`,
            },
          ],
          model: "sonar-pro",
          web_search_options: {
            ...(domainFilterArray.length > 0 ? { search_domain_filter: domainFilterArray } : {}),
            ...(recency_filter ? { search_recency_filter: recency_filter } : {}),
            user_location: {
              country: "CH",
            },
          },
        });

        if (!result || !result.choices[0]) {
          throw new Error("No content returned from internet search.");
        }

        // find [1] [2] etc.. occurences and replace them with JSON value like this:
        // {url: https://www.google.com, title: Google, snippet: The result of the web search.}
        // From the corresponding search_results (mind that [1] is 0 in the array).
        const content = result.choices[0].message.content as string;
        const parsed = {
          content: content.replace(/(\[([1-9][0-9]*)\])/g, (match, p1, p2) => {
            const index = parseInt(p2) - 1;
            if (!result.search_results || !result.search_results[index]) {
              return match;
            }
            return JSON.stringify({
              url: result.search_results[index].url,
              title: result.search_results[index].title,
              snippet: result.search_results[index].snippet,
            });
          }),
          citations: result.citations,
          search_results: result.search_results,
        };

        return {
          result: JSON.stringify(parsed),
        };
      } catch (error) {
        if (error instanceof Perplexity.RateLimitError && attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    return {
      result: "Max retries exceeded for perplexity research for query.",
    };
  },
});

export const perplexityTools = [internetSearchTool];
