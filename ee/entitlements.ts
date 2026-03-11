export const ENTITLEMENTS: {
    "rbac": boolean,
    "advanced-markdown-chunker": boolean,
    "agentic-retrieval": boolean,
    "queues": boolean,
    "custom-branding": boolean,
    "evals": boolean,
    "template-conversations": boolean,
    "agent-feedback": boolean,
    "multi-agent-tooling": boolean,
    "advanced-document-processing": boolean
} = {
    "rbac": false,
    "advanced-markdown-chunker": false,
    "agentic-retrieval": false,
    "queues": false,
    "custom-branding": false,
    "evals": false,
    "template-conversations": false,
    "agent-feedback": false,
    "multi-agent-tooling": false,
    "advanced-document-processing": false
}

export const checkLicense = () => {
    if (
        !process.env.EXULU_ENTERPRISE_LICENSE || 
        process.env.EXULU_ENTERPRISE_LICENSE === "" ||
        !process.env.EXULU_ENTERPRISE_LICENSE.startsWith("EXULU_EE_")
    ) {
        return ENTITLEMENTS
    } else {
        return {
            "rbac": true,
            "advanced-markdown-chunker": true,
            "agentic-retrieval": true,
            "mcp": true,
            "queues": true,
            "prompt-library": true,
            "custom-branding": true,
            "evals": true,
            "template-conversations": true,
            "agent-feedback": true,
            "multi-agent-tooling": true,
            "advanced-document-processing": true
        }
    }

}