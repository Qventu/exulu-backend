import type { TestCase } from "@EXULU_TYPES/models/test-case";
import { type UIMessage } from "ai";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";
import type { ExuluProvider } from "./provider";
import { checkLicense } from "@EE/entitlements";

interface ExuluEvalParams {
  id: string;
  name: string;
  description: string;
  llm: boolean;
  execute: (params: {
    agent: ExuluAgent;
    provider: ExuluProvider;
    messages: UIMessage[];
    testCase: TestCase;
    config?: Record<string, any>;
  }) => Promise<number>;
  config?: {
    name: string;
    description: string;
  }[];
  queue: Promise<ExuluQueueConfig>;
}

export class ExuluEval {
  public id: string;
  public name: string;
  public description: string;
  public llm: boolean;
  private execute: (params: {
    agent: ExuluAgent;
    testCase: TestCase;
    provider: ExuluProvider;
    messages: UIMessage[];
    config?: Record<string, any>;
  }) => Promise<number>;
  public config?: {
    name: string;
    description: string;
  }[];

  public queue?: Promise<ExuluQueueConfig>;

  constructor({ id, name, description, execute, config, queue, llm }: ExuluEvalParams) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.execute = execute;
    this.config = config;
    this.llm = llm;
    this.queue = queue;
  }

  public async run(
    agent: ExuluAgent,
    provider: ExuluProvider,
    testCase: TestCase,
    messages: UIMessage[],
    config?: Record<string, any>,
  ): Promise<number> {
    try {
      const score = await this.execute({ agent, provider, testCase, messages, config });
      if (score < 0 || score > 100) {
        throw new Error(
          `Eval function ${this.name} must return a score between 0 and 100, got ${score}`,
        );
      }
      return score;
    } catch (error: unknown) {
      console.error(`[EXULU] error running eval function ${this.name}.`, error);
      throw new Error(
        `Error running eval function ${this.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
