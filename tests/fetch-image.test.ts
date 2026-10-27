import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImageRejection, MAX_IMAGE_BYTES, fetchImage, isPrivateAddress, sniffImageMimeType } from "../src/fetch-image.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let server: Server;
let base: string;

beforeAll(async () => {
    server = createServer((req, res) => {
        const path = req.url ?? "/";
        if (path === "/cat.png") return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
        if (path === "/octet.png") return res.writeHead(200, { "content-type": "application/octet-stream" }).end(PNG);
        if (path === "/page.html") return res.writeHead(200, { "content-type": "text/html" }).end("<html>a cat</html>");
        if (path === "/missing.png") return res.writeHead(404).end();
        if (path === "/declared-huge.png") {
            return res.writeHead(200, { "content-type": "image/png", "content-length": String(MAX_IMAGE_BYTES + 1) }).end();
        }
        if (path === "/streamed-huge.png") {
            res.writeHead(200, { "content-type": "image/png" });
            const chunk = Buffer.alloc(1024 * 1024);
            for (let i = 0; i <= MAX_IMAGE_BYTES / chunk.length; i++) res.write(chunk);
            return res.end();
        }
        const redirect = /^\/redirect\/(\d+)$/.exec(path);
        if (redirect) {
            const left = Number(redirect[1]);
            return res.writeHead(302, { location: left > 1 ? `/redirect/${left - 1}` : "/cat.png" }).end();
        }
        if (path === "/redirect-to-ftp") return res.writeHead(302, { location: "ftp://example.com/cat.png" }).end();
        return res.writeHead(500).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const local = { allowPrivateAddresses: true };

describe("fetchImage", () => {
    it("downloads an image and sniffs its type", async () => {
        const image = await fetchImage(`${base}/cat.png`, local);
        expect(image.mimeType).toBe("image/png");
        expect(Buffer.from(image.bytes)).toEqual(PNG);
    });

    it("trusts the bytes, not the content-type header", async () => {
        await expect(fetchImage(`${base}/octet.png`, local)).resolves.toMatchObject({ mimeType: "image/png" });
        await expect(fetchImage(`${base}/page.html`, local)).rejects.toThrow("must point directly to a JPEG, PNG, WebP or GIF");
    });

    it("follows up to 3 redirects", async () => {
        await expect(fetchImage(`${base}/redirect/3`, local)).resolves.toMatchObject({ mimeType: "image/png" });
        await expect(fetchImage(`${base}/redirect/4`, local)).rejects.toThrow("redirected too many times");
    });

    it("rejects non-http links, including after a redirect", async () => {
        await expect(fetchImage("ftp://example.com/cat.png", local)).rejects.toThrow("must be an http(s) URL");
        await expect(fetchImage(`${base}/redirect-to-ftp`, local)).rejects.toThrow("must be an http(s) URL");
        await expect(fetchImage("not a url", local)).rejects.toThrow("not a valid URL");
    });

    it("rejects HTTP errors", async () => {
        await expect(fetchImage(`${base}/missing.png`, local)).rejects.toThrow("HTTP 404");
    });

    it("rejects images over the size limit, declared or streamed", async () => {
        await expect(fetchImage(`${base}/declared-huge.png`, local)).rejects.toThrow("larger than 10 MB");
        await expect(fetchImage(`${base}/streamed-huge.png`, local)).rejects.toThrow("larger than 10 MB");
    });

    it("enforces allowedHosts", async () => {
        await expect(fetchImage(`${base}/cat.png`, { ...local, allowedHosts: ["127.0.0.1"] })).resolves.toBeDefined();
        await expect(fetchImage(`${base}/cat.png`, { ...local, allowedHosts: ["i.imgur.com"] })).rejects.toThrow(
            "Images must be hosted on one of: i.imgur.com"
        );
    });

    it("refuses private and local addresses", async () => {
        await expect(fetchImage(`${base}/cat.png`)).rejects.toThrow("private or local network address");
        await expect(fetchImage(`http://localhost:${new URL(base).port}/cat.png`)).rejects.toThrow("private or local network address");
        await expect(fetchImage("http://[::1]/cat.png")).rejects.toThrow("private or local network address");
    });

    it("downloads through the proxy when one is set", async () => {
        const proxied: string[] = [];
        const proxy = createServer((req, res) => {
            proxied.push(`${req.method} ${req.url}`);
            const upstream = request(req.url!, { method: req.method, headers: req.headers }, (upstreamRes) => {
                res.writeHead(upstreamRes.statusCode!, upstreamRes.headers);
                upstreamRes.pipe(res);
            });
            req.pipe(upstream);
        });
        proxy.on("connect", (req, clientSocket, head) => {
            proxied.push(`CONNECT ${req.url}`);
            const [host, port] = req.url!.split(":");
            const upstream = connect(Number(port), host, () => {
                clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                upstream.write(head);
                upstream.pipe(clientSocket);
                clientSocket.pipe(upstream);
            });
        });
        await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        try {
            const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
            await expect(fetchImage(`${base}/cat.png`, { ...local, proxyUrl })).resolves.toMatchObject({ mimeType: "image/png" });
            expect(proxied).toHaveLength(1);
            expect(proxied[0]).toContain(new URL(base).host);
        } finally {
            proxy.closeAllConnections();
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
        }
    });

    it("throws ImageRejection so its message can be shown to the author", async () => {
        await expect(fetchImage(`${base}/missing.png`, local)).rejects.toBeInstanceOf(ImageRejection);
    });
});

describe("isPrivateAddress", () => {
    it.each([
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.1.1",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "fd00::1",
        "fe80::1",
        "::ffff:127.0.0.1"
    ])("%s is private", (address) => expect(isPrivateAddress(address)).toBe(true));
    it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("%s is public", (address) =>
        expect(isPrivateAddress(address)).toBe(false)
    );
});

describe("sniffImageMimeType", () => {
    it("recognises the supported formats", () => {
        expect(sniffImageMimeType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
        expect(sniffImageMimeType(PNG)).toBe("image/png");
        expect(sniffImageMimeType(Buffer.from("GIF89a"))).toBe("image/gif");
        expect(sniffImageMimeType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
        expect(sniffImageMimeType(Buffer.from("<html>"))).toBeUndefined();
    });
});
