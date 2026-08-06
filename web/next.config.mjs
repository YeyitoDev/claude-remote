/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // La app es 100% cliente (habla con el servidor por REST/WS), así que se
  // exporta como estático y el propio servidor la sirve. Un solo túnel
  // expone front y API en el mismo origen.
  output: 'export',
  images: { unoptimized: true },
}

export default nextConfig
