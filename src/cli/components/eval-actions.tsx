import React, { useState } from 'react';
import { ProgressBar, Select, UnorderedList } from "@inkjs/ui";
import type { ExuluAgent, ExuluAgentEval } from '../../registry/classes';
import { Text } from 'ink';

const EvalActions = ({ agent, evaluation, setEvaluation }: { agent: ExuluAgent, evaluation: ExuluAgentEval, setEvaluation: (evaluation?: ExuluAgentEval) => void }) => {

    const [progress, setProgress] = useState<number>(0);
    const [results, setResults] = useState<{
        name: string,
        input: string,
        score: number,
        comment: string,
    }[]>([]);
    const [running, setRunning] = useState<undefined | {
        label: string,
    }>();

    const run = async (evaluation: ExuluAgentEval) => {

        setRunning({
            label: evaluation.runner.name,
        })

        const testCases = evaluation.runner.testcases;

        const total = testCases.length;

        if (!testCases) {
            throw new Error("No test cases found");
        }

        let i = 0;
        for (const testCase of testCases) {
            i++;
            const result = await evaluation.runner.run({
                data: testCase,
                runner: {
                    agent: agent
                }
            })
            setProgress(Math.round((i / total) * 100));
            setResults([...results, {
                name: evaluation.runner.name,
                prompt: testCase.prompt?.slice(0, 100) + "...",
                score: result.score,
                comment: result.comment,
            }]);
        }
        setRunning(undefined);
    }

    if (progress === 100) {
        return <>
            <Text>Evaluations completed.</Text>
            <UnorderedList>
                {results.map(result => (
                    <UnorderedList.Item>
                        <Text>{result.name}: {result.score} - {result.comment}</Text>
                    </UnorderedList.Item>
                ))}
            </UnorderedList>
        </>
    }
    if (running) {
        return <>
            <Text>Running {running.label}...</Text>
            <ProgressBar value={progress} />
        </>
    }
    return (
        <Select options={[{
            label: "Run evaluation",
            value: "run"
        }, {
            label: "Go back",
            value: "back"
        }]} onChange={(value) => {
            if (value === "back") {
                setEvaluation(undefined);
            }
            if (value === "run") {
                run(evaluation);
            }
        }} />
    )
}

export default EvalActions;