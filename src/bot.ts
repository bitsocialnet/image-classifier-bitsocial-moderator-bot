import type { Decision } from "./classify.js";
import type { Config } from "./config.js";
import type { ModerationDecision } from "./pkc.js";

export type QueuedComment = {
    cid: string;
    link?: string;
    parentCid?: string;
    timestamp: number;
};

type ModQueuePage = { comments: QueuedComment[]; nextCid?: string };

// The slice of a pkc-js community the bot uses, so tests can pass a fake.
export interface QueueCommunity {
    modQueue: { pageCids: Record<string, string | undefined>; getPage(args: { cid: string }): Promise<unknown> };
    exportCommunityModLogs(opts: { commentCid: string }): Promise<{ moderations: { commentModeration?: { approved?: boolean } }[] }>;
}

export type BotDeps = {
    community: QueueCommunity;
    classify(link: string | undefined): Promise<Decision>;
    moderate(commentCid: string, decision: ModerationDecision): Promise<void>;
    config: Pick<Config, "retryBaseSeconds" | "retryMaxSeconds">;
    now?: () => number;
    log?: (message: string) => void;
};

// Approves or rejects every post in the community's mod queue by its linked image. Posts that can't be
// classified right now (model server down) stay queued and are retried with backoff.
export class ModQueueBot {
    // published a decision; the queue page still lists the comment until the community republishes it
    private readonly decided = new Set<string>();
    private readonly retries = new Map<string, { attempts: number; nextAt: number }>();
    private readonly now: () => number;
    private readonly log: (message: string) => void;

    constructor(private readonly deps: BotDeps) {
        this.now = deps.now ?? Date.now;
        this.log = deps.log ?? console.log;
    }

    async readQueue(): Promise<QueuedComment[]> {
        const { modQueue } = this.deps.community;
        const comments: QueuedComment[] = [];
        let cid = modQueue.pageCids.pendingApproval;
        while (cid) {
            const page = (await modQueue.getPage({ cid })) as ModQueuePage;
            comments.push(...page.comments);
            cid = page.nextCid;
        }
        return comments.sort((a, b) => a.timestamp - b.timestamp);
    }

    // A moderator (or this bot before a restart) may already have decided; never moderate a comment twice.
    private async alreadyDecided(commentCid: string) {
        const { moderations } = await this.deps.community.exportCommunityModLogs({ commentCid });
        return moderations.some((moderation) => typeof moderation.commentModeration?.approved === "boolean");
    }

    private scheduleRetry(cid: string, error: string) {
        const attempts = (this.retries.get(cid)?.attempts ?? 0) + 1;
        const { retryBaseSeconds, retryMaxSeconds } = this.deps.config;
        const delaySeconds = Math.min(retryBaseSeconds * 2 ** (attempts - 1), retryMaxSeconds);
        this.retries.set(cid, { attempts, nextAt: this.now() + delaySeconds * 1000 });
        this.log(`${cid}: ${error}; retry #${attempts} in ${delaySeconds}s`);
    }

    async scan(): Promise<void> {
        const queue = await this.readQueue();
        const queued = new Set(queue.map((comment) => comment.cid));
        for (const cid of this.decided) if (!queued.has(cid)) this.decided.delete(cid);
        for (const cid of this.retries.keys()) if (!queued.has(cid)) this.retries.delete(cid);

        for (const comment of queue) {
            // only posts are sent to the queue for their image; anything else is left to human moderators
            if (comment.parentCid || this.decided.has(comment.cid)) continue;
            const retry = this.retries.get(comment.cid);
            if (retry && retry.nextAt > this.now()) continue;

            try {
                if (await this.alreadyDecided(comment.cid)) {
                    this.decided.add(comment.cid);
                    continue;
                }
                const decision = await this.deps.classify(comment.link);
                if (decision.kind === "retry") {
                    this.scheduleRetry(comment.cid, decision.error);
                    continue;
                }
                const approved = decision.kind === "approve";
                await this.deps.moderate(comment.cid, approved ? { approved } : { approved, reason: decision.reason });
                this.decided.add(comment.cid);
                this.retries.delete(comment.cid);
                const share = decision.allowedShare === undefined ? "" : ` (allowed share ${decision.allowedShare.toFixed(3)})`;
                this.log(`${comment.cid}: ${approved ? "approved" : `rejected: ${decision.reason}`}${share} ${comment.link ?? ""}`);
            } catch (error) {
                // The decision may have landed anyway (another moderator or bot instance got there first, or the
                // verification was lost); the mod log is the source of truth.
                if (await this.alreadyDecided(comment.cid).catch(() => false)) {
                    this.decided.add(comment.cid);
                    this.retries.delete(comment.cid);
                    this.log(`${comment.cid}: already decided according to the mod log (${String(error)})`);
                    continue;
                }
                this.scheduleRetry(comment.cid, String(error));
            }
        }
    }
}

// Runs scan() on every community update and on a timer, at most one at a time; updates that arrive during a
// scan are coalesced into one follow-up scan.
export function createScanScheduler(scan: () => Promise<void>, onError: (error: unknown) => void) {
    let scanning = false;
    let rescan = false;
    let stopped = false;
    return {
        schedule() {
            if (stopped) return;
            if (scanning) {
                rescan = true;
                return;
            }
            scanning = true;
            void (async () => {
                do {
                    rescan = false;
                    try {
                        await scan();
                    } catch (error) {
                        onError(error);
                    }
                } while (rescan && !stopped);
                scanning = false;
            })();
        },
        stop() {
            stopped = true;
        }
    };
}
