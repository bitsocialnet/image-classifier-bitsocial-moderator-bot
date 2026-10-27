import { ModQueueBot, createScanScheduler, type QueueCommunity } from "./bot.js";
import { ImageClassifier } from "./classify.js";
import { loadConfig } from "./config.js";
import { createPkc, loadSigner, publishModeration } from "./pkc.js";

async function main() {
    const config = loadConfig();
    const pkc = await createPkc(config.rpcUrl);
    const signer = await loadSigner(pkc, config.dataDir);
    const community = await pkc.createCommunity({ address: config.communityAddress });
    community.on("error", (error: unknown) => console.error("community error:", error));

    const role = community.roles?.[signer.address]?.role;
    if (role !== "moderator" && role !== "admin" && role !== "owner") {
        throw new Error(`The bot (${signer.address}) has no moderator role in ${config.communityAddress}; add it to community.roles first`);
    }

    const classifier = new ImageClassifier(config.classifier);
    const bot = new ModQueueBot({
        community: community as unknown as QueueCommunity,
        classify: (link) => classifier.classify(link),
        moderate: (commentCid, decision) => publishModeration(pkc, signer, config.communityAddress, commentCid, decision),
        config
    });
    const scheduler = createScanScheduler(
        () => bot.scan(),
        (error) => console.error("scan failed:", error)
    );

    community.on("update", () => scheduler.schedule());
    await community.update();
    const rescanTimer = setInterval(() => scheduler.schedule(), config.rescanIntervalSeconds * 1000);
    scheduler.schedule();
    console.log(
        `image classifier bot (${signer.address}) moderating ${config.communityAddress} with ${config.classifier.model} at ${config.classifier.mlUrl}`
    );

    const shutdown = async () => {
        console.log("shutting down");
        scheduler.stop();
        clearInterval(rescanTimer);
        await community.stop().catch(() => {});
        await pkc.destroy();
        process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
