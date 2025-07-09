import { Text } from 'ink';
import { Select } from "@inkjs/ui";
import { ExuluAgent, type ExuluAgentEval } from '../../registry/classes';
import type { ExuluApp } from '../../registry';

const AgentSelector = ({ exulu, setAgent, setEvaluations }: { exulu: ExuluApp, setAgent: (agent: ExuluAgent) => void, setEvaluations: (evaluations: ExuluAgentEval[]) => void }) => {

    const agents = exulu.agents.map(agent => ({
		label: agent.name,
		value: agent.id
	}))

    return (
        <>
            <Text>
                Please select an agent:
            </Text>
            <Select options={agents} onChange={(value) => {
                console.log("selected agent", value);
                const agent = exulu.agent(value);
                if (!agent) {
                    console.error("Agent not found", value);
                    return;
                }
                setAgent(agent);
                if (agent) {
                    setEvaluations(agent.evals || []);
                }
            }} />
        </>
    )
}

export default AgentSelector;