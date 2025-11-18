import { ExuluAgent } from "../../../../registry/classes"
import { createVertex } from '@ai-sdk/google-vertex'

const wrapperJsonGoogleAuth = `{
                    "project": "project-name",
                    "location": "europe-west1",
                    "googleAuthOptions": {
                        "credentials": {
                            "type": "service_account",
                            "project_id": "XX-XXXX",
                            "private_key_id": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
                            "private_key": "-----BEGIN PRIVATE KEY-----\n .... your private key .... \n-----END PRIVATE KEY-----\n",
                            "client_email": "xxxx@xxxx.gserviceaccount.com",
                            "client_id": "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
                            "universe_domain": "googleapis.com"
                        }
                    }
                }`

export const vertexGemini25FlashAgent = new ExuluAgent({
    id: `default_vertex_gemini_2_5_flash_agent`,
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
    authenticationInformation: `Vertex uses Google Auth, to authenticate you need to visit 
    https://console.cloud.google.com/apis/credentials, create a service account, go to 'keys'
     and download the resulting JSON file, and copy the contents of the JSON file into an 
     encrypted authentication variable in your IMP Agent Instance like this: ${wrapperJsonGoogleAuth}.`,
    maxContextLength: 1048576,
    config: {
        name: `GEMINI-2.5-FLASH`,
        instructions: "",
        model: {
            create: ({ apiKey }) => {

                console.log("[EXULU] apiKey", apiKey)

                if (!apiKey) {
                    throw new Error("Auth credentials not found for Google Vertex agent, make sure you have set the provider api key to a valid google authentication json.");
                }

                const googleAuthPayload = JSON.parse(apiKey || "{}");

                if (!googleAuthPayload) {
                    throw new Error("API key not found for Google Vertex Gemini 2.5 Flash agent.");
                }

                if (!googleAuthPayload.location) {
                    throw new Error("Location not set in authentication json for Google Vertex Gemini 2.5 Flash agent, should be for example 'europe-west1'");
                }

                const vertex = createVertex(googleAuthPayload);

                const model = vertex("gemini-2.5-flash")
                return model;
            },
        }
    }
})