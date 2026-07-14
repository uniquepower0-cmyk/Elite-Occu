import path from 'path';

// Set FONTCONFIG_PATH so sharp/librsvg can find Cairo and other custom fonts on Vercel/Serverless
const fontsDir = path.join(process.cwd(), 'fonts');
process.env.FONTCONFIG_PATH = fontsDir;
console.log(`[Fontconfig] Setting FONTCONFIG_PATH to: ${process.env.FONTCONFIG_PATH}`);
