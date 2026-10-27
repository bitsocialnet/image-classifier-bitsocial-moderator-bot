// Creates the bot's signing key in <dataDir>/bot-signer.json and prints its address, which the community must
// list as a moderator. Key generation is local, so this needs no running node.
import PKC from "@pkcprotocol/pkc-js";
import { loadConfig } from "../src/config.js";
import { createAndStoreSigner } from "../src/pkc.js";

const config = loadConfig();
const pkc = await PKC({ dataPath: undefined, httpRoutersOptions: [] });
try {
    const signer = await createAndStoreSigner(pkc, config.dataDir);
    console.log(`Signer saved. Its address is:\n\n  ${signer.address}\n`);
    console.log(`Make it a moderator of ${config.communityAddress}:`);
    console.log(`  bitsocial community edit ${config.communityAddress} '--roles["${signer.address}"].role' moderator`);
} finally {
    await pkc.destroy();
}
