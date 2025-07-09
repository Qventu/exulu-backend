import { Select } from "@inkjs/ui";
import type { ExuluAgentEval } from '../../registry/classes';

const EvalSelector = ({ evaluations, setEvaluation }: { evaluations: ExuluAgentEval[], setEvaluation: (evaluation: ExuluAgentEval) => void }) => {
	return (
		<Select options={evaluations.map(evaluation => ({
            label: evaluation.runner.name,
            value: evaluation.runner.name
        }))} onChange={(value) => {
            console.log("selected eval", value);
            const evaluation = evaluations?.find((evaluation: ExuluAgentEval) => evaluation.runner.name === value);
            if (evaluation) {
                setEvaluation(evaluation);
            }
        }} />
	)
}

export default EvalSelector;