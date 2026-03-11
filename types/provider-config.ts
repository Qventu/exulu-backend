import { type LanguageModel } from "ai";

export type ExuluProviderConfig = {
    name: string;
    instructions: string;
    model: {
        create: ({ apiKey }: { apiKey?: string | undefined }) => LanguageModel;
    };
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