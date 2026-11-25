/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 容器镜像只拷 .next/standalone（自带最小 node_modules），见 frontend/Dockerfile。
  // 只在容器构建时开启：Windows 非开发者模式没有创建符号链接的特权，
  // standalone 的 node_modules 拷贝会 EPERM 失败，本地构建必须保持默认输出。
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  // 后端接口地址通过 NEXT_PUBLIC_API_BASE 注入，见 .env.example
  env: {
    NEXT_PUBLIC_API_BASE:
      process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000/api/v1",
  },
};

export default nextConfig;
