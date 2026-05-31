import sharp from 'sharp';
import fs from 'fs';

const svgApp = fs.readFileSync('./public/icon-app.svg');
const svgFavicon = fs.readFileSync('./public/favicon.svg');

const icons = [
  { src: svgApp, name: 'public/favicon-16x16.png', size: 16 },
  { src: svgApp, name: 'public/favicon-32x32.png', size: 32 },
  { src: svgApp, name: 'public/apple-touch-icon.png', size: 180 },
  { src: svgApp, name: 'public/pwa-192x192.png', size: 192 },
  { src: svgApp, name: 'public/pwa-512x512.png', size: 512 },
];

for (const { src, name, size } of icons) {
  await sharp(src).resize(size, size).png().toFile(name);
  console.log(`Generated ${name} (${size}x${size})`);
}
