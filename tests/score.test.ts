import { describe, expect, it } from "vitest";
import { scoreLabels } from "../src/score.js";

describe("scoreLabels", () => {
    it("sums the probabilities of every allowed label", () => {
        const scores = scoreLabels(
            [1, 0],
            [
                [1, 0],
                [1, 0],
                [0, 1]
            ],
            2
        );
        expect(scores.allowedShare).toBeCloseTo(1, 6);
        expect(scores.probabilities[0]).toBeCloseTo(0.5, 6);
        expect(scores.topIndex).toBe(0);
    });

    it("is unaffected by embedding length", () => {
        const a = scoreLabels(
            [3, 0.3],
            [
                [2, 0],
                [0, 5]
            ],
            1
        );
        const b = scoreLabels(
            [1, 0.1],
            [
                [1, 0],
                [0, 1]
            ],
            1
        );
        expect(a.allowedShare).toBeCloseTo(b.allowedShare, 9);
    });

    it("points topIndex at a disallowed label when it wins", () => {
        expect(
            scoreLabels(
                [0, 1],
                [
                    [1, 0],
                    [0, 1]
                ],
                1
            ).topIndex
        ).toBe(1);
    });

    it("rejects mismatched dimensions", () => {
        expect(() => scoreLabels([1, 0], [[1, 0, 0]], 1)).toThrow("different dimensions");
    });
});
