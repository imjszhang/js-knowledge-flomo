import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, writeClipboardText } from "../web/src/browser-compat.js";

test("UUID generation uses the native method with its crypto receiver when available", () => {
  const expected = "8678c487-258d-4e33-b3d8-fb82f65eef06";
  const crypto = {
    randomUUID(): typeof expected { assert.equal(this, crypto); return expected; },
    getRandomValues() { throw new Error("fallback should not run"); },
  };
  assert.equal(randomUUID(crypto), expected);
});

test("HTTP UUID fallback reads 16 secure random bytes and only changes version and variant bits", () => {
  const entropy = Uint8Array.from([0, 1, 2, 3, 4, 5, 0xe6, 7, 0x48, 9, 10, 11, 12, 13, 14, 15]);
  let calls = 0;
  const crypto: Parameters<typeof randomUUID>[0] = {
    getRandomValues(array) {
      assert.equal(this, crypto);
      assert.ok(array instanceof Uint8Array);
      assert.equal(array.length, 16);
      array.set(entropy);
      calls++;
      return array;
    },
  };
  assert.equal(randomUUID(crypto), "00010203-0405-4607-8809-0a0b0c0d0e0f");
  assert.equal(calls, 1);
});

test("HTTP UUID fallback always produces RFC 4122 v4 version and variant bits", () => {
  for (const byte of [0x00, 0x3f, 0x40, 0x7f, 0x80, 0xbf, 0xc0, 0xff]) {
    const uuid = randomUUID({ getRandomValues(array) {
      assert.ok(array instanceof Uint8Array);
      array.fill(byte);
      return array;
    } });
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test("UUID generation refuses to substitute an insecure random source", () => {
  assert.throws(() => randomUUID({} as Crypto), /安全随机数/);
});

test("missing clipboard rejects asynchronously with actionable guidance", async () => {
  const result = writeClipboardText("workspace-command", {} as Clipboard);
  assert.ok(result instanceof Promise);
  await assert.rejects(result, /HTTPS 或 localhost/);
});

test("clipboard writing keeps the native receiver and reports permission failures", async () => {
  const clipboard = { async writeText(text: string) { assert.equal(this, clipboard); assert.equal(text, "workspace-command"); } } as Clipboard;
  await writeClipboardText("workspace-command", clipboard);
  await assert.rejects(writeClipboardText("workspace-command", {
    async writeText() { throw new Error("NotAllowedError"); },
  } as unknown as Clipboard), /允许浏览器使用剪贴板/);
});
