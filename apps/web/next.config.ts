import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@metis/types'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1'}/:path*`,
      },
    ];
  },
};

export default nextConfig;
