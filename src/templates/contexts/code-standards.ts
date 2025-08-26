import { ExuluContext } from "../../registry/classes";

export const codeStandardsContext = new ExuluContext({
    id: "code-standards",
    name: "Code Standards",
    description: "Code standards that can be used with the Exulu CLI.",
    fields: [{
        name: "Best practices",
        type: "longText"
    }, {
        name: "Code style",
        type: "longText"
    }, {
        name: "Tech stack",
        type: "longText"
    }],
    active: true
})