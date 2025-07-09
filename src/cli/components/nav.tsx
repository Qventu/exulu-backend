import { Select, Alert, UnorderedList, ProgressBar } from "@inkjs/ui";
import { Box, Text, useApp, render } from 'ink';

const nav = [
    {
        label: 'Agents',
        value: 'agents'
    },
    {
        label: 'Exit',
        value: 'exit'
    }
];

const Nav = ({ setView }: { setView: (view: string) => void }) => {

    const { exit } = useApp();

    return (
        <Select options={nav} onChange={(value) => {
            if (value === 'exit') {
                exit();
            }
            setView(value);
        }} />
    )
}

export default Nav;