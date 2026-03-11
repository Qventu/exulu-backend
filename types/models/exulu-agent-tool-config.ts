export type ExuluAgentToolConfig = {
    id: string;
    type: string;
    config: {
      name: string;
      variable: string | boolean | number; // is a variable name
      type: "boolean" | "string" | "number" | "variable";
      value?: any; // fetched on demand from the database based on the variable name
      default?: string | boolean | number;
    }[];
  }