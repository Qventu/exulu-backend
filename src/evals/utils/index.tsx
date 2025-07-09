import type { ExuluEvalInput } from "../../registry/classes"

// Generates a test set for needle in a haystack evaluations.
export const ExuluEvalUtils = {
    niahTestSet: ({
        label,
        contextlengths,
        needles,
        testDocument,
    }: {
        label: string,
        contextlengths: (5000 | 30000 | 50000 | 128000)[],
        needles: {
            question: string,
            answer: string
        }[],
        testDocument: string,
    }): ExuluEvalInput[] => {
        const testCases = contextlengths.map((contextlength) => {
    
            // context length is in tokens, so we multiply by 4 to get the number of chars
            // this is a rough estimate, as the number of chars is not always 4
            // we subtract 1000 to leave room for the needles.
            let testText = testDocument.slice(0, (contextlength * 4) - needles.length * 200)
    
            const depthInterval = 5000 * 4 // 5000 tokens * 4 chars per token
            const depths = Array.from({ length: (contextlength * 4) / (depthInterval) }, (_, i) => (i + 1) * (depthInterval))
    
            console.log("[EXULU] contextlength: ", {
                tokens: contextlength,
                chars: contextlength * 4,
                depths: depths
            })
    
            return depths.map((depth, index) => {
    
                const first = index === 0
                const last = index === depths.length - 1
                const start = first ? 0 : depths[index - 1]
                const end = last ? contextlength * 4 : depths[index]
    
                console.log("[EXULU] Niah positions: ", {
                    start: start,
                    end: end,
                    depth: depth,
                    index: index
                })
    
                // Create a copy of testText for this specific test case
                let modifiedTestText = testText
    
                // Track insertion positions to prevent overlapping
                const insertions: { position: number; needle: string }[] = []
    
                // Calculate all insertion positions first
                needles.forEach((needle, index) => {
                    // get a random position between start and end
                    const basePosition = start! + Math.floor(Math.random() * (end! - start!))
                    insertions.push({ position: basePosition, needle: needle.answer })
                })
    
                // Sort insertions by position to insert from end to beginning
                // This prevents position shifts when inserting from beginning
                insertions.sort((a, b) => b.position - a.position)
    
                console.log("[EXULU] Niah insertions: ", insertions)
    
                // Insert needles from end to beginning to maintain correct positions
                insertions.forEach(({ position, needle }) => {
                    // Ensure we don't go beyond the text length
                    const insertionPosition = Math.min(position, modifiedTestText.length)
    
                    // Insert the needle at the calculated position
                    const beforeNeedle = modifiedTestText.slice(0, insertionPosition)
                    const afterNeedle = modifiedTestText.slice(insertionPosition)
                    modifiedTestText = beforeNeedle + needle + afterNeedle
                })
    
                return {
                    prompt: `You are a helpful assistant.
    
                You are given a text.
    
                You need to answer the following question, using only the information from the text provided below. Do not hallucinate
                or come up with an answer that is not in the text. If the text does not contain the answer, you should say "I don't know".
    
                ${needles.map((needle, index) => `- ${index + 1}: ${needle.question}`).join("\n")}
    
                The text is:
                
                ${modifiedTestText}
                `,
                    category: `${label}-context-length-[${contextlength}]-depth-[from-${start ? start / 4 : 0}-to-${end ? end / 4 : 0}]-niah-test`,
                    metadata: {
                        contextLength: contextlength,
                        depth: depth,
                        needles: needles
                    }
                }
            })
        })
    
        const flattenedTestCases = testCases.flat()
    
        console.log("[EXULU] Niah test cases: ", flattenedTestCases.length)
        console.table(flattenedTestCases.map(data => ({
            chars: data.prompt?.length || 0,
            tokens: data.prompt?.length / 4 || 0,
            category: data.category,
            metadata: data.metadata
        })))
    
        return flattenedTestCases;
    }
}