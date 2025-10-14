import { ExuluAgent } from "../../../../registry/classes"
import { createVertex } from '@ai-sdk/google-vertex'
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';

export const claudeOpus4Agent = new ExuluAgent({
    id: `default_vertex_gemini_2_5_flash_agent`,
    name: `GEMINI-2.5-FLASH`,
    provider: "google vertex",
    description: `Google Vertex Gemini 2.5 Flash model. Very high intelligence and capability. Moderately Fast.`,
    type: "agent",
    capabilities: {
        text: true,
        images: [".png", ".jpg", ".jpeg", ".webp"],
        files: [".pdf", ".txt"],
        audio: [".mpeg", ".mp3", ".m4a", ".wav", ".mp4"],
        video: [".mp4", ".mpeg"],
    },
    evals: [],
    maxContextLength: 1048576,
    config: {
        name: `GEMINI-2.5-FLASH`,
        instructions: "",
        model: {
            create: ({ apiKey }) => {
                // todo !
                const vertex = createVertex({
                    project: 'my-project', // optional
                    location: 'us-central1', // optional
                });
                const model = vertex("gemini-2.5-flash")
                return model;
            },
            // todo add a field of type string that adds a dropdown list from which the user can select the model
            // todo for each model, check which provider is used, and require the admin to add one or multiple
            //   API keys for the provider (which we can then auto-rotate).
            // todo also add custom fields for rate limiting, so the admin can set custom rate limits for the agent
            //   and allow him/her to decide if the rate limit is per user or per agent.
            // todo finally allow switching on or off immutable audit logs on the agent. Which then enables OTEL
            //   and stores the logs into the pre-defined storage.
        }
    }
})

export const claudeSonnet45Agent = new ExuluAgent({
    id: `default_vertex_claude_sonnet_4_5_agent`,
    name: `CLAUDE-SONNET-4.5`,
    provider: "google vertex",
    description: `Google Vertex Claude Sonnet 4.5 model. Very high intelligence and capability. Moderately Fast.`,
    type: "agent",
    capabilities: {
        text: true,
        images: [".png", ".jpg", ".jpeg", ".webp"],
        files: [".pdf", ".txt"],
        audio: [],
        video: [],
    },
    evals: [],
    maxContextLength: 200000,
    config: {
        name: `CLAUDE-SONNET-4.5`,
        instructions: "",
        model: {
            create: ({ apiKey }) => {
                // todo !
                const vertexAnthropic = createVertexAnthropic({
                    project: 'my-project', // optional
                    location: 'us-central1', // optional
                });
                const model = vertexAnthropic('claude-sonnet-4-5@20250929');
                return model;
            },
            // todo add a field of type string that adds a dropdown list from which the user can select the model
            // todo for each model, check which provider is used, and require the admin to add one or multiple
            //   API keys for the provider (which we can then auto-rotate).
            // todo also add custom fields for rate limiting, so the admin can set custom rate limits for the agent
            //   and allow him/her to decide if the rate limit is per user or per agent.
            // todo finally allow switching on or off immutable audit logs on the agent. Which then enables OTEL
            //   and stores the logs into the pre-defined storage.
        }
    }
})

export const claudeOpus41Agent = new ExuluAgent({
    id: `default_vertex_claude_sonnet_4_5_agent`,
    name: `CLAUDE-OPUS-4.1`,
    provider: "google vertex",
    description: `Google Vertex Claude Opus 4.1 model. Very high intelligence and capability. Moderately Fast.`,
    type: "agent",
    capabilities: {
        text: true,
        images: [".png", ".jpg", ".jpeg", ".webp"],
        files: [".pdf", ".txt"],
        audio: [],
        video: [],
    },
    evals: [],
    maxContextLength: 200000,
    config: {
        name: `CLAUDE-OPUS-4.1`,
        instructions: "",
        model: {
            create: ({ apiKey }) => {
                // todo !
                const vertexAnthropic = createVertexAnthropic({
                    project: 'my-project', // optional
                    location: 'us-central1', // optional
                });
                const model = vertexAnthropic('claude-opus-4-1@20250805');
                return model;
            },
            // todo add a field of type string that adds a dropdown list from which the user can select the model
            // todo for each model, check which provider is used, and require the admin to add one or multiple
            //   API keys for the provider (which we can then auto-rotate).
            // todo also add custom fields for rate limiting, so the admin can set custom rate limits for the agent
            //   and allow him/her to decide if the rate limit is per user or per agent.
            // todo finally allow switching on or off immutable audit logs on the agent. Which then enables OTEL
            //   and stores the logs into the pre-defined storage.
        }
    }
})