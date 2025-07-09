import React, { useState } from 'react';
import type { ExuluApp } from '../registry';
import { Box, Text, render } from 'ink';
import { ExuluAgent, type ExuluAgentEval } from '../registry/classes';
import { UnorderedList } from "@inkjs/ui";
import patchConsole from 'patch-console';
import Nav from './components/nav';
import AgentSelector from './components/agent-selector';
import EvalSelector from './components/eval-selector';
import EvalActions from './components/eval-actions';

const Main = ({ exulu }: { exulu: ExuluApp }) => {

	patchConsole((stream, data) => {
		// stream = 'stdout'
		// data = "Hello World"
		setLogs([...logs, data]);
	});

	const [logs, setLogs] = useState<string[]>([]);
	const [view, setView] = useState<undefined | { value: string }>();
	const [agent, setAgent] = useState<undefined | ExuluAgent>();
	const [evaluations, setEvaluations] = useState<ExuluAgentEval[]>([]);
	const [evaluation, setEvaluation] = useState<undefined | ExuluAgentEval>();
	

	return <Box borderStyle="round" borderColor="cyan" padding={1} flexDirection="column" width={"70%"}>
		<Text>Logs:</Text>
		<UnorderedList>
			{
				logs.map((log, index) => (
					<UnorderedList.Item>
						<Text>{log}</Text>
					</UnorderedList.Item>
				))
			}
		</UnorderedList>
		{
			!view && <Nav setView={setView} />
		}
		{
			view === 'agents' && !agent && <AgentSelector exulu={exulu} setAgent={setAgent} setEvaluations={setEvaluations} />
		}
		{
			view === 'agents' && agent && !evaluation && <>
				<Text >Selected agent "{agent.name}". Please select an evaluation:</Text>
				<EvalSelector evaluations={evaluations} setEvaluation={setEvaluation} />
			</>
		}
		{
			view === 'agents' && agent && evaluation && <>
				<Text>Selected evaluation: {evaluation.runner.name}</Text>
				<EvalActions agent={agent} evaluation={evaluation} setEvaluation={setEvaluation} />
			</>
		}
	</Box>
};

export default {
	run: (exulu: ExuluApp) => {
		render(<Main exulu={exulu} />);
	}
}

/* 
	const evals = agent.evals?.map(_eval => ({
		name: _eval.runner.name,
		description: _eval.runner.description,
	}));

	if (!evals) {
		throw new Error("No evals found");
	}

	const testCases = await agent.evals[0]?.predefinedTestCases()

	if (!testCases) {
		throw new Error("No predefined test cases found");
	}

	for (const testCase of testCases) {
		const result = await agent.evals[0]?.runner.run({
			data: testCase,
			agent_id: agent.id
		})

		console.log(result);
	}
 */