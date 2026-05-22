import { ExuluProvider } from "@SRC/exulu/provider";
import { createVertex } from "@ai-sdk/google-vertex";
import { createVertexMaas } from "@ai-sdk/google-vertex/maas";
import { buildLabels, createLabeledFetch } from "./labels";

const vertexAuthenticationInformation = `
### Vertex Authentication Setup (Google Auth)

Vertex uses **Google Auth**. To authenticate, follow these steps:

1. Visit the Google Cloud Credentials page:
   **[https://console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)**

2. Create a **Service Account**.

3. Navigate to **Keys** → **Add Key** → **Create new key** → select **JSON**.

4. Download the generated JSON key file.

5. Copy the **entire contents** of the JSON file into an **encrypted authentication variable** in your IMP Agent Instance, using a structure like this:

\`\`\`json
{
    "project": "project-name",
    "location": "europe-west1",
    "googleAuthOptions": {
        "credentials": {
            "type": "service_account",
            "project_id": "XX-XXXX",
            "private_key_id": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
            "private_key": "-----BEGIN PRIVATE KEY-----.....-----END PRIVATE KEY-----",
            "client_email": "xxxx@xxxx.gserviceaccount.com",
            "client_id": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
            "universe_domain": "googleapis.com"
        }
    }
}
\`\`\`
`;

export const vertexLlamaScout4 = new ExuluProvider({
  id: `default_vertex_llama_scout_provider`,
  name: `LLAMA-SCOUT-4`,
  provider: "vertex",
  description: `Google Vertex Llama Scout 4 model. 10 million token context, good for document analysis and retrieval.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".txt"],
    audio: [".mpeg", ".mp3", ".m4a", ".wav", ".mp4"],
    video: [".mp4", ".mpeg"],
  },
  authenticationInformation: vertexAuthenticationInformation,
  maxContextLength: 1048576, // theoretical max is 10m, but capped on managed apis on vertex
  config: {
    name: `LLAMA-SCOUT-4`,
    instructions: "",
    model: {
      create: ({ apiKey, user, role, project, agent }) => {
        if (!apiKey) {
          throw new Error(
            "Auth credentials not found for Google Vertex agent, make sure you have set the provider api key to a valid google authentication json.",
          );
        }

        const googleAuthPayload = JSON.parse(apiKey || "{}");

        if (!googleAuthPayload) {
          throw new Error("API key not found for Google Vertex Gemini 2.5 Flash agent.");
        }

        if (!googleAuthPayload.location) {
          throw new Error(
            "Location not set in authentication json for Google Vertex Gemini 2.5 Flash agent, should be for example 'europe-west1'",
          );
        }

        const labels = buildLabels({
          providerId: "default_vertex_llama_scout_provider",
          providerName: "LLAMA-SCOUT-4",
          user,
          role,
          project,
          agent,
        });

        const vertexMaasProvider = createVertexMaas({
          ...googleAuthPayload,
          fetch: createLabeledFetch(labels),
        });

        const model = vertexMaasProvider("meta/llama-4-scout-17b-16e-instruct-maas");
        return model;
      },
    },
  },
});

export const vertexGemini25FlashProvider = new ExuluProvider({
  id: `default_vertex_gemini_2_5_flash_provider`,
  name: `GEMINI-2.5-FLASH`,
  provider: "vertex",
  description: `Google Vertex Gemini 2.5 Flash model. Very high intelligence and capability. Moderately Fast.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".txt"],
    audio: [".mpeg", ".mp3", ".m4a", ".wav", ".mp4"],
    video: [".mp4", ".mpeg"],
  },
  authenticationInformation: vertexAuthenticationInformation,
  maxContextLength: 1048576,
  config: {
    name: `GEMINI-2.5-FLASH`,
    instructions: "",
    model: {
      create: ({ apiKey, user, role, project, agent }) => {
        if (!apiKey) {
          throw new Error(
            "Auth credentials not found for Google Vertex agent, make sure you have set the provider api key to a valid google authentication json.",
          );
        }

        const googleAuthPayload = JSON.parse(apiKey || "{}");

        if (!googleAuthPayload) {
          throw new Error("API key not found for Google Vertex Gemini 2.5 Flash agent.");
        }

        if (!googleAuthPayload.location) {
          throw new Error(
            "Location not set in authentication json for Google Vertex Gemini 2.5 Flash agent, should be for example 'europe-west1'",
          );
        }

        const labels = buildLabels({
          providerId: "default_vertex_gemini_2_5_flash_provider",
          providerName: "GEMINI-2.5-FLASH",
          user,
          role,
          project,
          agent,
        });

        const vertex = createVertex({
          ...googleAuthPayload,
          fetch: createLabeledFetch(labels),
        });

        const model = vertex("gemini-2.5-flash");
        return model;
      },
    },
  },
});

export const vertexGemini25ProProvider = new ExuluProvider({
  id: `default_vertex_gemini_2_5_pro_provider`,
  name: `GEMINI-2.5-PRO`,
  provider: "vertex",
  description: `Google Vertex Gemini 2.5 Pro model. Very high intelligence and capability. Moderately Fast.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".txt"],
    audio: [".mpeg", ".mp3", ".m4a", ".wav", ".mp4"],
    video: [".mp4", ".mpeg"],
  },
  authenticationInformation: vertexAuthenticationInformation,
  maxContextLength: 1048576,
  config: {
    name: `GEMINI-2.5-PRO`,
    instructions: "",
    model: {
      create: ({ apiKey, user, role, project, agent }) => {
        if (!apiKey) {
          throw new Error(
            "Auth credentials not found for Google Vertex agent, make sure you have set the provider api key to a valid google authentication json.",
          );
        }

        const googleAuthPayload = JSON.parse(apiKey || "{}");

        if (!googleAuthPayload) {
          throw new Error("API key not found for Google Vertex Gemini 2.5 Pro agent.");
        }

        if (!googleAuthPayload.location) {
          throw new Error(
            "Location not set in authentication json for Google Vertex Gemini 2.5 Pro agent, should be for example 'europe-west1'",
          );
        }

        const labels = buildLabels({
          providerId: "default_vertex_gemini_2_5_pro_provider",
          providerName: "GEMINI-2.5-PRO",
          user,
          role,
          project,
          agent,
        });

        const vertex = createVertex({
          ...googleAuthPayload,
          fetch: createLabeledFetch(labels),
        });

        const model = vertex("gemini-2.5-pro");
        return model;
      },
    },
  },
});

export const vertexGemini20FlashProvider = new ExuluProvider({
  id: `default_vertex_gemini_2_0_flash_provider`,
  name: `GEMINI-2.0-FLASH`,
  provider: "vertex",
  description: `Google Vertex Gemini 2.0 Flash model. High intelligence and capability. Moderately Fast.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".txt"],
    audio: [".mpeg", ".mp3", ".m4a", ".wav", ".mp4"],
    video: [".mp4", ".mpeg"],
  },
  authenticationInformation: vertexAuthenticationInformation,
  maxContextLength: 1048576,
  config: {
    name: `GEMINI-2.0-FLASH`,
    instructions: "",
    model: {
      create: ({ apiKey, user, role, project, agent }) => {
        if (!apiKey) {
          throw new Error(
            "Auth credentials not found for Google Vertex agent, make sure you have set the provider api key to a valid google authentication json.",
          );
        }

        const googleAuthPayload = JSON.parse(apiKey || "{}");

        if (!googleAuthPayload) {
          throw new Error("API key not found for Google Vertex Gemini 2.0 Flash agent.");
        }

        if (!googleAuthPayload.location) {
          throw new Error(
            "Location not set in authentication json for Google Vertex Gemini 2.0 Flash agent, should be for example 'europe-west1'",
          );
        }

        const labels = buildLabels({
          providerId: "default_vertex_gemini_2_0_flash_provider",
          providerName: "GEMINI-2.0-FLASH",
          user,
          role,
          project,
          agent,
        });

        const vertex = createVertex({
          ...googleAuthPayload,
          fetch: createLabeledFetch(labels),
        });

        const model = vertex("gemini-2.0-flash");
        return model;
      },
    },
  },
});

export const vertexGemini3ProProvider = new ExuluProvider({
  id: `default_vertex_gemini_3_pro_provider`,
  name: `GEMINI-3-PRO`,
  provider: "vertex",
  description: `Google Vertex Gemini 3 Pro model. Very high intelligence and capability. Moderately Fast.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".txt"],
    audio: [".mpeg", ".mp3", ".m4a", ".wav", ".mp4"],
    video: [".mp4", ".mpeg"],
  },
  authenticationInformation: vertexAuthenticationInformation,
  maxContextLength: 1048576,
  config: {
    name: `GEMINI-3-PRO`,
    instructions: "",
    model: {
      create: ({ apiKey, user, role, project, agent }) => {
        if (!apiKey) {
          throw new Error(
            "Auth credentials not found for Google Vertex agent, make sure you have set the provider api key to a valid google authentication json.",
          );
        }

        const googleAuthPayload = JSON.parse(apiKey || "{}");

        if (!googleAuthPayload) {
          throw new Error("API key not found for Google Vertex Gemini 3 Pro agent.");
        }

        if (!googleAuthPayload.location) {
          throw new Error(
            "Location not set in authentication json for Google Vertex Gemini 3 Pro agent, should be for example 'europe-west1'",
          );
        }

        const labels = buildLabels({
          providerId: "default_vertex_gemini_3_pro_provider",
          providerName: "GEMINI-3-PRO",
          user,
          role,
          project,
          agent,
        });

        const vertex = createVertex({
          ...googleAuthPayload,
          fetch: createLabeledFetch(labels),
        });

        // Todo update
        const model = vertex("gemini-3-pro-preview");
        return model;
      },
    },
  },
});
