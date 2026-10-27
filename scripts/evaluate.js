// Tune labels and threshold on your own images before turning the challenge on.
//
//   node scripts/evaluate.js <config.json> <images-dir> <positive-group>[,<positive-group>...]
//
// <config.json> is the bot config whose "classifier" settings you want to test (see config.example.json).
// <images-dir> has one subfolder per group of images,
// e.g. images/cat, images/dog, images/drawing; the positive groups are the ones that should pass.
// Prints every image's score and how many images each threshold would get wrong.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const [configPath, imagesDir, positiveArg] = process.argv.slice(2);
if (!configPath || !imagesDir || !positiveArg) {
    console.error("usage: node scripts/evaluate.js <config.json> <images-dir> <positive-group>[,<positive-group>...]");
    process.exit(1);
}

const LOGIT_SCALE = 100; // keep in sync with src/score.ts
const options = JSON.parse(await readFile(configPath, "utf8")).classifier;
const mlUrl = (options.mlUrl || "http://127.0.0.1:3003").replace(/\/+$/, "");
const model = options.model || "ViT-B-16-SigLIP2__webli";
const { allowed, disallowed } = options;
const labels = [...allowed, ...disallowed];
const positiveGroups = new Set(positiveArg.split(","));

async function embed(kind, input) {
    const form = new FormData();
    form.append("entries", JSON.stringify({ clip: { [kind]: { modelName: model, options: {} } } }));
    if (kind === "visual") form.append("image", new Blob([input]), "image");
    else form.append("text", input);
    const response = await fetch(`${mlUrl}/predict`, {
        method: "POST",
        body: form,
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : undefined
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const vector = JSON.parse((await response.json()).clip);
    const length = Math.hypot(...vector);
    return vector.map((value) => value / length);
}

const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const labelEmbeddings = await Promise.all(labels.map((label) => embed("textual", label)));

const rows = [];
for (const group of (await readdir(imagesDir)).sort()) {
    const groupDir = path.join(imagesDir, group);
    for (const file of (await readdir(groupDir)).sort()) {
        let image;
        try {
            image = await embed("visual", await readFile(path.join(groupDir, file)));
        } catch (error) {
            console.error(`skipped ${group}/${file}: ${error.message}`);
            continue;
        }
        const logits = labelEmbeddings.map((label) => dot(image, label) * LOGIT_SCALE);
        const max = Math.max(...logits);
        const exps = logits.map((logit) => Math.exp(logit - max));
        const total = exps.reduce((sum, value) => sum + value, 0);
        const probabilities = exps.map((value) => value / total);
        const share = probabilities.slice(0, allowed.length).reduce((sum, value) => sum + value, 0);
        const top = labels[probabilities.indexOf(Math.max(...probabilities))];
        rows.push({ group, file, positive: positiveGroups.has(group), share, top });
    }
}

for (const row of rows.sort((a, b) => a.share - b.share)) {
    console.log(`${row.positive ? "+" : "-"} ${row.share.toFixed(3)}  ${row.group.padEnd(12)} ${row.top.padEnd(40)} ${row.file}`);
}
const positives = rows.filter((row) => row.positive);
const negatives = rows.filter((row) => !row.positive);
console.log(`\n${model}: ${positives.length} should pass, ${negatives.length} should be rejected`);
for (const threshold of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7]) {
    const wronglyRejected = positives.filter((row) => row.share < threshold).length;
    const wronglyAccepted = negatives.filter((row) => row.share >= threshold).length;
    console.log(
        `threshold ${threshold}: wrongly rejected ${wronglyRejected}/${positives.length}, wrongly accepted ${wronglyAccepted}/${negatives.length}`
    );
}
