import { checkLicense } from "@EE/entitlements.ts";

/**
 * The channel tables (agent_channels, channel_links, chat_state_*) exist only on
 * installations licensed for `channels`; code that runs on every installation touches them
 * only when this is true. Read at call time: the licence is an environment variable.
 */
export const channelsLicensed = (): boolean => checkLicense()["channels"] === true;
