import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModQueueBot, type QueuedComment } from "../src/bot.js";
import type { Decision } from "../src/classify.js";

const post = (cid: string, link: string, timestamp: number): QueuedComment => ({ cid, link, timestamp });

let pages: Record<string, { comments: QueuedComment[]; nextCid?: string }>;
let pageCids: Record<string, string | undefined>;
let modLogs: Record<string, { commentModeration?: { approved?: boolean } }[]>;
let clock: number;
const classify = vi.fn<(link: string | undefined) => Promise<Decision>>();
const moderate = vi.fn();

const createBot = () =>
    new ModQueueBot({
        community: {
            modQueue: { pageCids, getPage: async ({ cid }) => pages[cid] },
            exportCommunityModLogs: async ({ commentCid }) => ({ moderations: modLogs[commentCid] ?? [] })
        },
        classify,
        moderate,
        config: { retryBaseSeconds: 30, retryMaxSeconds: 100 },
        now: () => clock,
        log: () => {}
    });

beforeEach(() => {
    vi.resetAllMocks();
    pages = {};
    pageCids = {};
    modLogs = {};
    clock = 1_000_000;
    moderate.mockResolvedValue(undefined);
});

describe("ModQueueBot", () => {
    it("does nothing when the queue is empty", async () => {
        await createBot().scan();
        expect(classify).not.toHaveBeenCalled();
    });

    it("approves and rejects every queued post, oldest first, across pages", async () => {
        pageCids.pendingApproval = "page1";
        pages.page1 = { comments: [post("dog", "https://i.imgur.com/dog.png", 2)], nextCid: "page2" };
        pages.page2 = { comments: [post("cat", "https://i.imgur.com/cat.png", 1)] };
        classify.mockImplementation(async (link) =>
            link?.includes("cat")
                ? { kind: "approve", allowedShare: 0.9 }
                : { kind: "reject", reason: "looks like a dog", allowedShare: 0.01 }
        );

        await createBot().scan();

        expect(moderate.mock.calls).toEqual([
            ["cat", { approved: true }],
            ["dog", { approved: false, reason: "looks like a dog" }]
        ]);
    });

    it("leaves replies to human moderators", async () => {
        pageCids.pendingApproval = "page1";
        pages.page1 = { comments: [{ ...post("reply", "https://i.imgur.com/x.png", 1), parentCid: "Qm..." }] };
        await createBot().scan();
        expect(classify).not.toHaveBeenCalled();
    });

    it("skips posts a moderator already approved or rejected", async () => {
        pageCids.pendingApproval = "page1";
        pages.page1 = { comments: [post("handled", "https://i.imgur.com/cat.png", 1)] };
        modLogs.handled = [{ commentModeration: { approved: false } }];
        await createBot().scan();
        expect(classify).not.toHaveBeenCalled();
        expect(moderate).not.toHaveBeenCalled();
    });

    it("still classifies posts whose only moderation was not a decision", async () => {
        pageCids.pendingApproval = "page1";
        pages.page1 = { comments: [post("flaired", "https://i.imgur.com/cat.png", 1)] };
        modLogs.flaired = [{ commentModeration: {} }];
        classify.mockResolvedValue({ kind: "approve", allowedShare: 0.9 });
        await createBot().scan();
        expect(moderate).toHaveBeenCalledWith("flaired", { approved: true });
    });

    it("does not moderate the same post twice while the queue page is stale", async () => {
        pageCids.pendingApproval = "page1";
        pages.page1 = { comments: [post("cat", "https://i.imgur.com/cat.png", 1)] };
        classify.mockResolvedValue({ kind: "approve", allowedShare: 0.9 });
        const bot = createBot();
        await bot.scan();
        await bot.scan();
        expect(moderate).toHaveBeenCalledTimes(1);
    });

    it("keeps a post queued and retries with capped backoff when classification can't run", async () => {
        pageCids.pendingApproval = "page1";
        pages.page1 = { comments: [post("cat", "https://i.imgur.com/cat.png", 1)] };
        classify.mockResolvedValue({ kind: "retry", error: "model server down" });
        const bot = createBot();

        await bot.scan(); // attempt 1, next in 30s
        clock += 29_000;
        await bot.scan(); // not due yet
        expect(classify).toHaveBeenCalledTimes(1);

        clock += 1_000;
        await bot.scan(); // attempt 2, next in 60s
        clock += 60_000;
        await bot.scan(); // attempt 3, next in min(120, 100) = 100s
        clock += 99_000;
        await bot.scan();
        expect(classify).toHaveBeenCalledTimes(3);

        classify.mockResolvedValue({ kind: "approve", allowedShare: 0.9 });
        clock += 1_000;
        await bot.scan();
        expect(moderate).toHaveBeenCalledWith("cat", { approved: true });
    });

    it("counts a failed publish as done when the mod log shows the decision landed", async () => {
        pageCids.pendingApproval = "page1";
        pages.page1 = { comments: [post("cat", "https://i.imgur.com/cat.png", 1)] };
        classify.mockResolvedValue({ kind: "approve", allowedShare: 0.9 });
        moderate.mockImplementationOnce(async () => {
            modLogs.cat = [{ commentModeration: { approved: true } }];
            throw new Error("comment that's not pending approval");
        });
        const bot = createBot();

        await bot.scan();
        clock += 3_600_000;
        await bot.scan();
        expect(moderate).toHaveBeenCalledTimes(1);
    });

    it("retries when publishing the decision fails", async () => {
        pageCids.pendingApproval = "page1";
        pages.page1 = { comments: [post("cat", "https://i.imgur.com/cat.png", 1)] };
        classify.mockResolvedValue({ kind: "approve", allowedShare: 0.9 });
        moderate.mockRejectedValueOnce(new Error("pubsub timeout"));
        const bot = createBot();

        await bot.scan();
        clock += 30_000;
        await bot.scan();
        expect(moderate).toHaveBeenCalledTimes(2);
    });
});
