/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@mapmotion/engine'],
  reactStrictMode: false, // the map/animation loop manages its own lifecycle
};

export default nextConfig;
