import type { ExuluRightsMode } from "./rbac-rights-modes";

// Workflows in Exulu are "template conversations"
// that contain variables that can be set on each
// invocation. Basically they are a set of UIMessages
// that get run in the background on invocation instead
// of manually in a chat session.
export interface ExuluWorkflow {
    id: string;
    name: string;
    description?: string;
    rights_mode?: ExuluRightsMode;
    RBAC?: {
        users?: Array<{ id: string; rights: "read" | "write" }>;
        roles?: Array<{ id: string; rights: "read" | "write" }>;
    };
    created_by: number;
    createdAt: string;
    updatedAt: string;
    agent: string;
    steps_json?: WorkflowStep[];
}

interface WorkflowStep {
    id: string;
    type: "user" | "assistant" | "tool";
    content?: string;
    contentExample?: string;
    toolName?: string;
    variablesUsed?: string[];
}