import { z } from "zod";
import { Arithmetic } from "./utils/arithmetic";
import { Statistics } from "./utils/statistics";
import { Trigonometric } from "./utils/trigonometric";
import { ExuluTool } from "../../registry/classes";

const additionTool = new ExuluTool({
    id: "addition",
    name: "Addition",
    description: "Adds two numbers together",
    type: "function",
    config: [],
    inputSchema: z.object({
        firstNumber: z.number().describe("The first addend"),
        secondNumber: z.number().describe("The second addend"),
    }),
    execute: async ({ firstNumber, secondNumber }) => {
        const value = Arithmetic.add(firstNumber, secondNumber);
        return { result: `${value}` };
    },
});

const subtractionTool = new ExuluTool({
    id: "subtraction",
    name: "Subtraction",
    description: "Subtracts the second number from the first number",
    type: "function",
    config: [],
    inputSchema: z.object({
        minuend: z.number().describe("The number to subtract from (minuend)"),
        subtrahend: z.number().describe("The number being subtracted (subtrahend)"),
    }),
    execute: async ({ minuend, subtrahend }) => {
        const value = Arithmetic.subtract(minuend, subtrahend);
        return { result: `${value}` };
    },
});

const multiplicationTool = new ExuluTool({
    id: "multiplication",
    name: "Multiplication",
    description: "Multiplies two numbers together",
    type: "function",
    config: [],
    inputSchema: z.object({
        firstNumber: z.number().describe("The first number"),
        SecondNumber: z.number().describe("The second number"),
    }),
    execute: async ({ firstNumber, SecondNumber }) => {
        const value = Arithmetic.multiply(firstNumber, SecondNumber);
        return { result: `${value}` };
    },
});

const divisionTool = new ExuluTool({
    id: "division",
    name: "Division",
    description: "Divides the first number by the second number",
    type: "function",
    config: [],
    inputSchema: z.object({
        numerator: z.number().describe("The number being divided (numerator)"),
        denominator: z.number().describe("The number to divide by (denominator)"),
    }),
    execute: async ({ numerator, denominator }) => {
        const value = Arithmetic.division(numerator, denominator);
        return { result: `${value}` };
    },
});

const sumTool = new ExuluTool({
    id: "sum",
    name: "Sum",
    description: "Adds any number of numbers together",
    type: "function",
    config: [],
    inputSchema: z.object({
        numbers: z.array(z.number()).min(1).describe("Array of numbers to sum"),
    }),
    execute: async ({ numbers }) => {
        const value = Arithmetic.sum(numbers);
        return { result: `${value}` };
    },
});

const moduloTool = new ExuluTool({
    id: "modulo",
    name: "Modulo",
    description: "Divides two numbers and returns the remainder",
    type: "function",
    config: [],
    inputSchema: z.object({
        numerator: z.number().describe("The number being divided (numerator)"),
        denominator: z.number().describe("The number to divide by (denominator)"),
    }),
    execute: async ({ numerator, denominator }) => {
        const value = Arithmetic.modulo(numerator, denominator);
        return { result: `${value}` };
    },
});

const meanTool = new ExuluTool({
    id: "mean",
    name: "Mean",
    description: "Calculates the arithmetic mean of a list of numbers",
    type: "function",
    config: [],
    inputSchema: z.object({
        numbers: z.array(z.number()).min(1).describe("Array of numbers to find the mean of"),
    }),
    execute: async ({ numbers }) => {
        const value = Statistics.mean(numbers);
        return { result: `${value}` };
    },
});

const medianTool = new ExuluTool({
    id: "median",
    name: "Median",
    description: "Calculates the median of a list of numbers",
    type: "function",
    config: [],
    inputSchema: z.object({
        numbers: z.array(z.number()).min(1).describe("Array of numbers to find the median of"),
    }),
    execute: async ({ numbers }) => {
        const value = Statistics.median(numbers);
        return { result: `${value}` };
    },
});

const modeTool = new ExuluTool({
    id: "mode",
    name: "Mode",
    description: "Finds the most common number in a list of numbers",
    type: "function",
    config: [],
    inputSchema: z.object({
        numbers: z.array(z.number()).describe("Array of numbers to find the mode of"),
    }),
    execute: async ({ numbers }) => {
        const value = Statistics.mode(numbers);
        return { result: `Entries (${value.modeResult.join(', ')}) appeared ${value.maxFrequency} times` };
    },
});

const minTool = new ExuluTool({
    id: "min",
    name: "Minimum",
    description: "Finds the minimum value from a list of numbers",
    type: "function",
    config: [],
    inputSchema: z.object({
        numbers: z.array(z.number()).describe("Array of numbers to find the minimum of"),
    }),
    execute: async ({ numbers }) => {
        const value = Statistics.min(numbers);
        return { result: `${value}` };
    },
});

const maxTool = new ExuluTool({
    id: "max",
    name: "Maximum",
    description: "Finds the maximum value from a list of numbers",
    type: "function",
    config: [],
    inputSchema: z.object({
        numbers: z.array(z.number()).describe("Array of numbers to find the maximum of"),
    }),
    execute: async ({ numbers }) => {
        const value = Statistics.max(numbers);
        return { result: `${value}` };
    },
});

const floorTool = new ExuluTool({
    id: "floor",
    name: "Floor",
    description: "Rounds a number down to the nearest integer",
    type: "function",
    config: [],
    inputSchema: z.object({
        number: z.number().describe("The number to round down"),
    }),
    execute: async ({ number }) => {
        const value = Arithmetic.floor(number);
        return { result: `${value}` };
    },
});

const ceilingTool = new ExuluTool({
    id: "ceiling",
    name: "Ceiling",
    description: "Rounds a number up to the nearest integer",
    type: "function",
    config: [],
    inputSchema: z.object({
        number: z.number().describe("The number to round up"),
    }),
    execute: async ({ number }) => {
        const value = Arithmetic.ceil(number);
        return { result: `${value}` };
    },
});

const roundTool = new ExuluTool({
    id: "round",
    name: "Round",
    description: "Rounds a number to the nearest integer",
    type: "function",
    config: [],
    inputSchema: z.object({
        number: z.number().describe("The number to round"),
    }),
    execute: async ({ number }) => {
        const value = Arithmetic.round(number);
        return { result: `${value}` };
    },
});

const sinTool = new ExuluTool({
    id: "sin",
    name: "Sine",
    description: "Calculates the sine of a number in radians",
    type: "function",
    config: [],
    inputSchema: z.object({
        number: z.number().describe("The number in radians to find the sine of"),
    }),
    execute: async ({ number }) => {
        const value = Trigonometric.sin(number);
        return { result: `${value}` };
    },
});

const arcsinTool = new ExuluTool({
    id: "arcsin",
    name: "Arcsine",
    description: "Calculates the arcsine of a number in radians",
    type: "function",
    config: [],
    inputSchema: z.object({
        number: z.number().describe("The number to find the arcsine of"),
    }),
    execute: async ({ number }) => {
        const value = Trigonometric.arcsin(number);
        return { result: `${value}` };
    },
});

const cosTool = new ExuluTool({
    id: "cos",
    name: "Cosine",
    description: "Calculates the cosine of a number in radians",
    type: "function",
    config: [],
    inputSchema: z.object({
        number: z.number().describe("The number in radians to find the cosine of"),
    }),
    execute: async ({ number }) => {
        const value = Trigonometric.cos(number);
        return { result: `${value}` };
    },
});

const arccosTool = new ExuluTool({
    id: "arccos",
    name: "Arccosine",
    description: "Calculates the arccosine of a number in radians",
    type: "function",
    config: [],
    inputSchema: z.object({
        number: z.number().describe("The number to find the arccosine of"),
    }),
    execute: async ({ number }) => {
        const value = Trigonometric.arccos(number);
        return { result: `${value}` };
    },
});

const tanTool = new ExuluTool({
    id: "tan",
    name: "Tangent",
    description: "Calculates the tangent of a number in radians",
    type: "function",
    config: [],
    inputSchema: z.object({
        number: z.number().describe("The number in radians to find the tangent of"),
    }),
    execute: async ({ number }) => {
        const value = Trigonometric.tan(number);
        return { result: `${value}` };
    },
});

const arctanTool = new ExuluTool({
    id: "arctan",
    name: "Arctangent",
    description: "Calculates the arctangent of a number in radians",
    type: "function",
    config: [],
    inputSchema: z.object({
        number: z.number().describe("The number to find the arctangent of"),
    }),
    execute: async ({ number }) => {
        const value = Trigonometric.arctan(number);
        return { result: `${value}` };
    },
});

const radiansToDegreesTool = new ExuluTool({
    id: "radiansToDegrees",
    name: "Radians to Degrees",
    description: "Converts a radian value to its equivalent in degrees",
    type: "function",
    config: [],
    inputSchema: z.object({
        number: z.number().describe("The number in radians to convert to degrees"),
    }),
    execute: async ({ number }) => {
        const value = Trigonometric.radiansToDegrees(number);
        return { result: `${value}` };
    },
});

const degreesToRadiansTool = new ExuluTool({
    id: "degreesToRadians",
    name: "Degrees to Radians",
    description: "Converts a degree value to its equivalent in radians",
    type: "function",
    config: [],
    inputSchema: z.object({
        number: z.number().describe("The number in degrees to convert to radians"),
    }),
    execute: async ({ number }) => {
        const value = Trigonometric.degreesToRadians(number);
        return { result: `${value}` };
    },
});

export const mathTools = [
    additionTool,
    subtractionTool,
    multiplicationTool,
    divisionTool,
    sumTool,
    moduloTool,
    meanTool,
    medianTool,
    modeTool,
    minTool,
    maxTool,
    floorTool,
    ceilingTool,
    roundTool,
    sinTool,
    arcsinTool,
    cosTool,
    arccosTool,
    tanTool,
    arctanTool,
    radiansToDegreesTool,
    degreesToRadiansTool,
];