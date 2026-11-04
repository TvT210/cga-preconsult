/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 后端接口地址通过 NEXT_PUBLIC_API_BASE 注入，见 .env.example
  env: {
    NEXT_PUBLIC_API_BASE:
      process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000/api/v1",
  },
};

export default nextConfig;
