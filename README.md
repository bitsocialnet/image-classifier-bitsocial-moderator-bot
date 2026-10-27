# image-classifier-bitsocial-moderator-bot

A moderator bot for PKC (Bitsocial) communities that only want one kind of picture: only cats, only dogs, only food. New posts go to the community's mod queue, and the bot approves or rejects each one by classifying its linked image with a CLIP/SigLIP model on a server you host yourself. Posters never wait for the check, and no image goes to a third-party AI service.

It is a zero-shot classifier: you describe what is allowed and what is not in plain English, and no training is involved. Switching from cats to dogs is a config change.

## How it works

1. The community sends every new post to its mod queue. A built-in `publication-match` challenge with no patterns always succeeds, and `pendingApproval: true` routes posts that pass it to the queue. Moderators, admins and the owner are exempt, as are replies, votes and edits, so those publish directly.
2. The bot connects to the community's bitsocial daemon over pkc RPC, watches `community.modQueue`, and for each pending post:
    - checks `community.exportCommunityModLogs()` and skips the post if a moderator already approved or rejected it;
    - downloads the post's `link`, which must point directly to a JPEG, PNG, WebP or GIF image;
    - scores the image against every label on the model server (a softmax over cosine similarities);
    - publishes a `CommentModeration` approving the post when the allowed labels' combined probability is at least `threshold`, or rejecting it with a reason such as `Image rejected: it looks like "a photo of a dog". This community only accepts: "a photo of a cat", ...`.
3. Rejected posts are deleted after the community's `purgeDisapprovedCommentsOlderThan`.

If the problem is the post's link (not an image, too large, a host outside `allowedHosts`, a private address), the post is rejected with that reason. If the problem is on our side (model server down, network trouble), the post stays queued and the bot retries after 30 s, 60 s, 120 s, ... up to every 30 minutes. A moderator can approve or reject any queued post by hand at any time, and the bot leaves it alone.

## Requirements

- A bitsocial daemon (bitsocial-cli) running the community, reachable over pkc RPC. Running the bot on the same machine needs no RPC auth key.
- The [Immich machine-learning container](https://github.com/immich-app/immich/tree/main/machine-learning) as model server, which serves CLIP/SigLIP models on CPU. `deploy/docker-compose.yml` runs it on `127.0.0.1:3003` with the recommended model preloaded. It needs about 1 GB RAM, 1 GB disk and no GPU. One image takes about 0.1 s on a modern CPU.
- Node.js 22+.

## Set it up for your own community

You need to own the community (it runs on your bitsocial daemon) and be able to run Docker and Node.js 22+ on the same machine. The bot can also run elsewhere and reach the daemon over RPC with its auth key (`ws://host:9138/<auth-key>`), but the model server should sit next to the bot.

### 1. Start the model server

```bash
git clone https://github.com/bitsocialnet/image-classifier-bitsocial-moderator-bot.git
cd image-classifier-bitsocial-moderator-bot
docker compose -f deploy/docker-compose.yml up -d
docker logs -f image-classifier-ml   # wait for "Loading visual model"; the first start downloads ~800 MB
```

If the container keeps restarting with `NumPy was built with baseline optimizations: (X86_V2)`, the machine's (usually virtual) CPU is too old for the image's NumPy (`grep -c sse4_2 /proc/cpuinfo` prints `0`). Use the old-CPU build, which swaps in a NumPy that runs there. Classification then takes about 3 s per image instead of 0.1 s:

```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.old-cpu.yml up -d --build
```

### 2. Install the bot and describe your pictures

```bash
npm install --omit=dev
cp config.example.json config.json
```

In `config.json`, set `communityAddress` and the `classifier` labels. The cats example below is a good template: `allowed` is what you want, `disallowed` is everything people might post instead, especially look-alikes. For a dogs-only community, for example, swap the cat labels for `"a photo of a dog"`, `"a photo of a puppy"` and move `"a photo of a dog"` out of `disallowed` in favor of `"a photo of a cat"`, `"a photo of a wolf"`, `"a drawing or painting of a dog"`, `"a stuffed toy dog"`.

Before going live, check the labels and pick a threshold with your own images (see [Tuning labels](#tuning-labels-for-your-community)): `node scripts/evaluate.js config.json ./images dog`.

Decide where images may come from. `allowedHosts` limits links to hosts you trust; leave it empty to accept any host, and set `proxyUrl` if you don't want image hosts to see your server's IP (see [Privacy](#privacy-the-image-host-sees-who-downloads)).

### 3. Give the bot a moderator key

```bash
npm run create-signer
bitsocial community edit <community address> '--roles["<bot address>"].role' moderator
```

`create-signer` stores the key in `data/bot-signer.json` (readable only by its owner) and prints the bot's address and the exact `edit` command. The bot refuses to start without a moderator, admin or owner role.

### 4. Send new posts to the mod queue

Add a challenge that always succeeds and marks posts for approval, exempting moderators (including the bot) and everything that isn't a post, and set how long rejected posts are kept (here one day). [`examples/mod-queue-settings.json`](examples/mod-queue-settings.json) has exactly that:

```json
{
    "settings": {
        "purgeDisapprovedCommentsOlderThan": 86400,
        "challenges": [
            {
                "name": "publication-match",
                "description": "New posts wait for an image check before they appear.",
                "pendingApproval": true,
                "exclude": [
                    { "roles": ["moderator", "admin", "owner"] },
                    {
                        "publicationType": {
                            "reply": true,
                            "vote": true,
                            "commentEdit": true,
                            "commentModeration": true,
                            "communityEdit": true
                        }
                    }
                ]
            }
        ]
    }
}
```

`settings.challenges` replaces the community's whole challenge list, so add any challenges you already use to your copy (the cats example below puts the spam blocker first). Then apply it:

```bash
bitsocial community edit <community address> --jsonFile ./mod-queue-settings.json
```

Exempt moderators from every other challenge too (`"exclude": [{ "roles": ["moderator", "admin", "owner"] }]`), or the bot's approvals get challenged and fail. It's also worth telling posters in `rules` what is allowed, that a bot checks posts, and how long rejected ones are kept.

### 5. Run it

```bash
npm start
```

To keep it running, install `deploy/image-classifier-bot.service` as a systemd unit (it assumes the repo is at `/root/image-classifier-bot` and Node.js from nvm; adjust `WorkingDirectory` and the paths):

```bash
sudo cp deploy/image-classifier-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now image-classifier-bot
journalctl -u image-classifier-bot -f
```

### 6. Test it

Post an image from an account that is **not** a moderator (moderators skip the queue). Within a few seconds the log shows `approved` or `rejected: ...` with the score, and the post appears in the community or is shown to its author as rejected with the reason.

## Example: a cats-only community

This is the setup behind `onlycats.bso`. Big cats count as cats, captioned cat photos are allowed, and drawings, cartoons, AI art, sculptures and plush toys are not. The spam blocker runs first; posts that pass it go to the mod queue for the bot.

[`examples/onlycats-community.json`](examples/onlycats-community.json):

```json
{
    "title": "Only Cats",
    "description": "Pictures of cats. That's it.",
    "rules": [
        "Every post must link directly to an image (jpg, png, webp or gif) of a cat hosted on forgeimg.net or i.imgur.com. Big cats count.",
        "Real cats only: no drawings, cartoons, AI art, sculptures or plush toys. Captioned cat photos are fine.",
        "Replies can be anything.",
        "New posts are checked by a bot within a minute; rejected posts are deleted after a day."
    ],
    "settings": {
        "fetchThumbnailUrls": true,
        "purgeDisapprovedCommentsOlderThan": 86400,
        "challenges": [
            {
                "name": "@bitsocial/spam-blocker-challenge",
                "exclude": [{ "roles": ["moderator", "admin", "owner"] }]
            },
            {
                "name": "publication-match",
                "description": "New posts wait for the cat check before they appear.",
                "pendingApproval": true,
                "exclude": [
                    { "roles": ["moderator", "admin", "owner"] },
                    {
                        "publicationType": {
                            "reply": true,
                            "vote": true,
                            "commentEdit": true,
                            "commentModeration": true,
                            "communityEdit": true
                        }
                    }
                ]
            }
        ]
    }
}
```

```bash
bitsocial community create --jsonFile ./examples/onlycats-community.json
bitsocial community edit <address> '--roles["<bot address>"].role' moderator
```

And the bot's [`config.example.json`](config.example.json):

```json
{
    "rpcUrl": "ws://localhost:9138",
    "communityAddress": "onlycats.bso",
    "dataDir": "data",
    "classifier": {
        "mlUrl": "http://127.0.0.1:3003",
        "model": "ViT-B-16-SigLIP2__webli",
        "allowed": ["a photo of a cat", "a photo of a kitten", "a photo of a lion, tiger or other big cat"],
        "disallowed": [
            "a photo of a dog",
            "a photo of a fox",
            "a photo of another animal",
            "a drawing or painting of a cat",
            "a cartoon or illustration",
            "a statue or sculpture of a cat",
            "a stuffed toy cat",
            "a screenshot",
            "a photo of a person",
            "a photo of food",
            "a photo of an object or place"
        ],
        "threshold": 0.35,
        "allowedHosts": ["forgeimg.net", "i.imgur.com"]
    }
}
```

Instead of a proxy, it only accepts images from two hosts the operator trusts not to log or share the server's IP (`allowedHosts`).

How these labels did in testing, with `ViT-B-16-SigLIP2__webli` on 67 images that should pass (house cats, kittens, lions, captioned cat photos) and 45 that should not (dogs, foxes, rabbits, cat drawings, AI-generated cats, cartoons, cat sculptures, screenshots, food, people):

| threshold | cats wrongly rejected | non-cats wrongly accepted |
| --------- | --------------------- | ------------------------- |
| 0.3       | 1/67                  | 1/45                      |
| **0.35**  | **1/67**              | **0/45**                  |
| 0.4       | 2/67                  | 0/45                      |
| 0.5       | 4/67                  | 0/45                      |

The one cat rejected at 0.35 was almost entirely hidden behind a bicycle. The smaller `ViT-B-32-SigLIP2-256__webli` was much worse on the same set (6/67 cats rejected at its best threshold), and SigLIP2-L was no better than base. Treat these numbers as a starting point: the test set was small, so watch the bot's decisions after launch and adjust `threshold`.

## Configuration

`config.json` (or the file named by the `CONFIG` environment variable):

| Key                       | Default                   | Description                                                                                                                        |
| ------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `rpcUrl`                  | `ws://localhost:9138`     | pkc RPC of the daemon running the community. A remote daemon needs its auth key: `ws://host:9138/<auth-key>`.                      |
| `communityAddress`        | required                  | The community to moderate.                                                                                                         |
| `dataDir`                 | `data`                    | Holds the bot's signing key, `bot-signer.json`.                                                                                    |
| `classifier.allowed`      | required                  | Descriptions an image must match.                                                                                                  |
| `classifier.disallowed`   | required                  | What to reject. Most of the accuracy comes from this list: name the look-alikes you want kept out (other animals, drawings, toys). |
| `classifier.threshold`    | `0.5`                     | Minimum combined probability of the allowed labels, above 0 and at most 1. Lower lets more through.                                |
| `classifier.mlUrl`        | `http://127.0.0.1:3003`   | Base URL of the model server.                                                                                                      |
| `classifier.apiFormat`    | `immich`                  | Model server API. Only `immich` is implemented.                                                                                    |
| `classifier.apiKey`       | unset                     | Sent as `Authorization: Bearer <apiKey>`, for a model server behind an authenticating reverse proxy.                               |
| `classifier.model`        | `ViT-B-16-SigLIP2__webli` | Model name on the server; must match the container's preload setting. Re-run the evaluation after switching.                       |
| `classifier.allowedHosts` | `[]`                      | Hostnames images may be linked from, e.g. `["i.imgur.com"]`. Empty allows any host.                                                |
| `classifier.proxyUrl`     | unset                     | HTTP proxy for image downloads.                                                                                                    |
| `retryBaseSeconds`        | `30`                      | First retry delay for posts that could not be classified; doubles each attempt.                                                    |
| `retryMaxSeconds`         | `1800`                    | Longest retry delay.                                                                                                               |
| `rescanIntervalSeconds`   | `60`                      | The queue is rescanned on this interval as well as on every community update.                                                      |

## Tuning labels for your community

Labels are short English descriptions; `a photo of a ...` phrasing works best. Think about what people will try to post that is close to, but not, what you want, and add each as a disallowed label. `scripts/evaluate.js` scores your own images with a config's classifier settings:

```bash
# images/cat/*.jpg should pass; images/dog, images/drawing, ... should be rejected
node scripts/evaluate.js config.json ./images cat
```

It prints every image's score and how many images each threshold would get wrong. Collect 50+ images of each kind, including the hard cases, before picking a threshold.

## Limitations

### The image can be swapped after it is approved

The bot checks the image once. Whoever controls the server a link points to can later serve a different image at the same URL, and the post stays up. Moderators remove swapped images like any other rule-breaking post. `allowedHosts` limited to hosts that never let uploaders replace a file closes this.

### Privacy: the image host sees who downloads

Downloading an image reveals the bot machine's IP address to the server the link points to, and anyone can post a link to a server they control. Use `allowedHosts` to accept only hosts you trust, or `proxyUrl` so hosts see the proxy's address instead. The machine's IP is also visible to its peers on the p2p network; this only stops image hosts, who can be anyone, from linking that IP to your community.

The bot also refuses links that point to private, loopback or link-local addresses (including after redirects and DNS lookups), so a post can't make the bot request services on your network.

### What it can't tell

Zero-shot classification judges what an image looks like. It does not reliably read text, so a caption on a photo is mostly ignored, and it can be fooled by photorealistic AI-generated images. Expect a few wrong calls in both directions near the threshold. Moderators can remove a wrongly approved post, but pkc-js can't approve a comment that was already rejected, so a wrongly rejected author has to post again (and a moderator can approve the new post from the queue before the bot does).

## Download limits

- 10 second timeout for the download, 60 seconds for each model server request
- 10 MB maximum image size
- JPEG, PNG, WebP or GIF (the first frame), detected from the file's bytes, not its extension or `content-type`
- At most 3 redirects, each checked against `allowedHosts` and the private-address rules
- A generic browser `User-Agent`, since some image hosts refuse requests without one

## Development

```bash
npm ci
npm test
npm run type-check
```

## License

GPL-3.0-or-later. This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE).
