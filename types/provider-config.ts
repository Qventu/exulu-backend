import { type LanguageModel } from "ai";

export type ExuluProviderConfig = {
    name: string;
    instructions: string;
    model: {
        create: ({ apiKey, user, role, project, agent }: { apiKey?: string | undefined, user?: number, role?: string, project?: string, agent?: string }) => LanguageModel;
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