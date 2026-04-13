import { ExuluProvider } from "@SRC/exulu/provider";
import { createAzure } from '@ai-sdk/azure';

const azureAuthenticationInformation = `
`;

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
  authenticationInformation: azureAuthenticationInformation,
  maxContextLength: 1048576,
  config: {
    name: `GEMINI-2.5-FLASH`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
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

        const vertex = createVertex(googleAuthPayload);

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
      create: ({ apiKey }) => {
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

        const vertex = createVertex(googleAuthPayload);

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
      create: ({ apiKey }) => {
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

        const vertex = createVertex(googleAuthPayload);

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
      create: ({ apiKey }) => {
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

        const vertex = createVertex(googleAuthPayload);

        // Todo update
        const model = vertex("gemini-3-pro-preview");
        return model;
      },
    },
  },
});
