import fs from "node:fs/promises";
import path from "node:path";
import PKC from "@pkcprotocol/pkc-js";

export type PkcInstance = Awaited<ReturnType<typeof PKC>>;
export type BotSigner = Awaited<ReturnType<PkcInstance["createSigner"]>>;
export type BotCommunity = Awaited<ReturnType<PkcInstance["createCommunity"]>>;

export class ChallengedError extends Error {}

const PUBLISH_TIMEOUT_MS = 5 * 60_000;

export async function createPkc(rpcUrl: string): Promise<PkcInstance> {
    const pkc = await PKC({ pkcRpcClientsOptions: [rpcUrl] });
    // pkc-js has no default error listener; without one an unhandled 'error' would crash the process
    pkc.on("error", (error: unknown) => console.error("pkc error:", error));
    return pkc;
}

export const signerPath = (dataDir: string) => path.join(dataDir, "bot-signer.json");

interface StoredSigner {
    type: "ed25519";
    privateKey: string;
}

export async function loadSigner(pkc: PkcInstance, dataDir: string): Promise<BotSigner> {
    let stored: StoredSigner;
    try {
        stored = JSON.parse(await fs.readFile(signerPath(dataDir), "utf8"));
    } catch (error) {
        throw new Error(`Could not read ${signerPath(dataDir)}. Run \`npm run create-signer\` first.`, { cause: error });
    }
    return pkc.createSigner({ type: stored.type, privateKey: stored.privateKey });
}

export async function createAndStoreSigner(pkc: PkcInstance, dataDir: string): Promise<BotSigner> {
    const file = signerPath(dataDir);
    const exists = await fs.stat(file).then(
        () => true,
        () => false
    );
    if (exists) throw new Error(`${file} already exists; move it away first if you really want to rotate the key`);
    const signer = await pkc.createSigner();
    await fs.mkdir(dataDir, { recursive: true });
    const stored: StoredSigner = { type: "ed25519", privateKey: signer.privateKey! };
    await fs.writeFile(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
    return signer;
}

export type ModerationDecision = { approved: boolean; reason?: string };

// Approves or disapproves a comment pending in the mod queue. The bot never answers challenges: the community
// exempts moderators from its challenges, so being challenged means the bot is missing its moderator role or
// the exempt rule. Reported as ChallengedError.
export async function publishModeration(
    pkc: PkcInstance,
    signer: BotSigner,
    communityAddress: string,
    commentCid: string,
    decision: ModerationDecision
): Promise<void> {
    const moderation = await pkc.createCommentModeration({ communityAddress, signer, commentCid, commentModeration: decision });

    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            moderation.stop().catch(() => {});
            if (error) reject(error);
            else resolve();
        };
        const timeout = setTimeout(() => finish(new Error(`moderating ${commentCid} timed out`)), PUBLISH_TIMEOUT_MS);

        moderation.on("challenge", () =>
            finish(
                new ChallengedError(
                    `${communityAddress} challenged the bot; give it the moderator role and exempt moderators from every challenge`
                )
            )
        );
        moderation.on(
            "challengeverification",
            (verification: { challengeSuccess: boolean; reason?: string; challengeErrors?: Record<string, string> }) => {
                if (verification.challengeSuccess) finish();
                else
                    finish(
                        new Error(
                            `moderation of ${commentCid} rejected: ${verification.reason ?? JSON.stringify(verification.challengeErrors ?? {})}`
                        )
                    );
            }
        );
        moderation.on("error", (error: Error) => finish(error));

        moderation.publish().catch((error: Error) => finish(error));
    });
}
