/**
 * 二维码往返验证：生成 → 解码 → 比对。
 *
 * 为什么值得一条测试：二维码「看起来生成了」和「手机真能扫出来」是两回事。
 * URL 拼接错一个冒号、纠错等级设太低、尺寸压到极限，都会产生一张看着像码、
 * 实则扫不出来的图。这里用独立实现（jsQR）去解码 qrcode 生成的结果，
 * 两边算法不同，能形成真正的交叉验证。
 */

import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { PNG } from "pngjs";

import { buildLanUrl } from "./apiBase";

async function roundTrip(text: string): Promise<string> {
  const buffer = await QRCode.toBuffer(text, {
    width: 320,
    margin: 2,
    errorCorrectionLevel: "M",
    type: "png",
  });
  const png = PNG.sync.read(buffer);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return decoded?.data ?? "";
}

describe("二维码往返", () => {
  it("局域网老人端地址可被解码还原", async () => {
    const url = buildLanUrl({
      ip: "192.168.1.5",
      path: "/elder",
      pagePort: "3000",
      pageProtocol: "http:",
    });

    expect(url).toBe("http://192.168.1.5:3000/elder");
    await expect(roundTrip(url)).resolves.toBe(url);
  });

  it("带查询串的地址也能正确还原", async () => {
    const url = "http://10.0.0.8:3000/elder/report?patient=1&from=qr";
    await expect(roundTrip(url)).resolves.toBe(url);
  });

  it("本机回环地址同样可扫（本地自测场景）", async () => {
    const url = "http://127.0.0.1:3000/elder";
    await expect(roundTrip(url)).resolves.toBe(url);
  });
});
