type RandomSource = Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;

export function randomUUID(crypto: RandomSource = globalThis.crypto): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== "function") {
    throw new Error("当前浏览器不支持安全随机数，请更新浏览器后重试。");
  }

  // getRandomValues is also available on HTTP origins where randomUUID is not.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export async function writeClipboardText(text: string, clipboard = globalThis.navigator?.clipboard): Promise<void> {
  if (typeof clipboard?.writeText !== "function") {
    throw new Error("当前 HTTP 地址不支持自动复制，请改用 HTTPS 或 localhost，或通过页面地址中的工作区 ID 读取。");
  }
  try {
    await clipboard.writeText(text);
  } catch {
    throw new Error("无法访问剪贴板，请允许浏览器使用剪贴板，或通过页面地址中的工作区 ID 读取。");
  }
}
