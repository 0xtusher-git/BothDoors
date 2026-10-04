/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The browser/hydration checks run a production server, and `next dev` would
  // otherwise overwrite `.next` out from under them. Point NEXT_DIST_DIR at a
  // private directory and the two can never fight over build artifacts.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
