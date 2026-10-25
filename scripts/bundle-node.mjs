// Copies the Node.js runtime running this script into src-tauri/resources so the
// installer ships it next to the browser worker (see tauri.conf.json bundle.resources).
// Run by `beforeBuildCommand`; the installed app then doesn't need a global Node.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [major] = process.versions.node.split(".").map(Number);
if (major < 20) throw new Error(`Node.js 20+ is required to bundle (found ${process.version}).`);
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "resources");
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
fs.copyFileSync(process.execPath, target);
console.log(`bundled ${process.execPath} (${process.version}) -> ${target}`);
