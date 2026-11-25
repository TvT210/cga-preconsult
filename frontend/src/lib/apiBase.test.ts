import { describe, expect, it } from "vitest";
import { buildLanUrl, isLoopbackHost, resolveApiBase } from "./apiBase";

describe("resolveApiBase", () => {
  it("配置写的是回环地址、页面从局域网打开时，把 host 换成当前访问地址", () => {
    expect(
      resolveApiBase({
        explicit: "http://127.0.0.1:8000/api/v1",
        pageHost: "192.168.1.5",
        protocol: "http:",
      }),
    ).toBe("http://192.168.1.5:8000/api/v1");
  });

  it("localhost 配置同样会被替换", () => {
    expect(
      resolveApiBase({ explicit: "http://localhost:8000/api/v1", pageHost: "10.0.0.8" }),
    ).toBe("http://10.0.0.8:8000/api/v1");
  });

  it("页面本身也是回环时不做替换，保持本地开发原样", () => {
    expect(
      resolveApiBase({ explicit: "http://127.0.0.1:8000/api/v1", pageHost: "127.0.0.1" }),
    ).toBe("http://127.0.0.1:8000/api/v1");
  });

  it("配置成真实域名时不被改写（生产前后端分域名场景）", () => {
    expect(
      resolveApiBase({ explicit: "https://api.example.com/api/v1", pageHost: "192.168.1.5" }),
    ).toBe("https://api.example.com/api/v1");
  });

  it("未配置时跟随页面 host，默认 8000 端口", () => {
    expect(resolveApiBase({ pageHost: "192.168.1.5", protocol: "http:" })).toBe(
      "http://192.168.1.5:8000/api/v1",
    );
  });

  it("未配置且无页面 host 时退回回环地址", () => {
    expect(resolveApiBase({})).toBe("http://127.0.0.1:8000/api/v1");
  });

  it("去掉末尾斜杠", () => {
    expect(
      resolveApiBase({ explicit: "http://127.0.0.1:8000/api/v1//", pageHost: "127.0.0.1" }),
    ).toBe("http://127.0.0.1:8000/api/v1");
  });

  it("https 页面保持 https 协议", () => {
    expect(resolveApiBase({ pageHost: "cga.local", protocol: "https:" })).toBe(
      "https://cga.local:8000/api/v1",
    );
  });

  it("配置值不是合法 URL 时原样返回，不抛异常", () => {
    expect(resolveApiBase({ explicit: "not-a-url", pageHost: "192.168.1.5" })).toBe("not-a-url");
  });
});

describe("buildLanUrl", () => {
  it("拼出手机可访问的页面地址", () => {
    expect(
      buildLanUrl({ ip: "192.168.1.5", path: "/elder", pagePort: "3000", pageProtocol: "http:" }),
    ).toBe("http://192.168.1.5:3000/elder");
  });

  it("端口为空时不带冒号", () => {
    expect(buildLanUrl({ ip: "10.0.0.8", path: "/elder", pagePort: "" })).toBe(
      "http://10.0.0.8/elder",
    );
  });

  it("路径缺少前导斜杠会自动补上", () => {
    expect(buildLanUrl({ ip: "10.0.0.8", path: "elder/report", pagePort: "3000" })).toBe(
      "http://10.0.0.8:3000/elder/report",
    );
  });

  it("没有 IP 时返回空串，避免生成扫了打不开的二维码", () => {
    expect(buildLanUrl({ ip: "", path: "/elder" })).toBe("");
  });
});

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "localhost", "::1", "0.0.0.0", "  127.0.0.1  "])(
    "%s 视为回环",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(["192.168.1.5", "10.0.0.8", "api.example.com"])("%s 不是回环", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});
