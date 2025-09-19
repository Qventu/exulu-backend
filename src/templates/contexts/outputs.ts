import { ExuluContext } from "../../registry/classes";

export const outputsContext = new ExuluContext({
    id: "outputs_default_context",
    name: "Outputs",
    description: "Outputs from agent sessions that you have saved for re-used later.",
    configuration: {
        defaultRightsMode: "private",
        calculateVectors: "manual"
    },
    fields: [
        {
            name: "content",
            type: "longText"
        }
    ],
    active: true
})