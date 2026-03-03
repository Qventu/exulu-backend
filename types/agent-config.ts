import { type LanguageModel } from "ai";
import { z } from "zod";

export type ExuluAgentConfig = {
    name: string;
    instructions: string;
    model: {
        create: ({ apiKey }: { apiKey?: string | undefined }) => LanguageModel;
    };
    outputSchema?: z.ZodType;
    custom?: {
        name: string;
        description: string;
    }[];
    memory?: {
        lastMessages: number;
        vector: boolean;
        semanticRecall: {
            topK: number;
            messageRange: number;
        };
    };
};