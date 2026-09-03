import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const svg = await readFile(new URL('../build/icon.svg', import.meta.url));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map((size) => sharp(svg).resize(size, size).png().toBuffer()));
await writeFile(new URL('../build/icon.png', import.meta.url), pngs.at(-1));
await writeFile(new URL('../build/icon.ico', import.meta.url), await pngToIco(pngs));
