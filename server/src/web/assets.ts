// The web remote's files, compiled into the bridge binary (no CDN, no external requests).
import page from "./remote.html" with {type:"text"};
import script from "./remote.js" with {type:"text"};
import styles from "./remote.css" with {type:"text"};
import consoleHtml from "./console.html" with {type:"text"};
import consoleJs from "./console.js" with {type:"text"};
import consoleCss from "./console.css" with {type:"text"};
import xterm from "@xterm/xterm/lib/xterm.js" with {type:"text"};
import xtermCss from "@xterm/xterm/css/xterm.css" with {type:"text"};
import xtermLicense from "../../licenses/xterm.js-5.5.0-LICENSE.txt" with {type:"text"};
import iconFile from "./icon.png" with {type:"file"};
import { readFileSync } from "node:fs";
export const remotePage=page as unknown as string,remoteScript:string=script,remoteStyles:string=styles,xtermStyles:string=xtermCss;
// The bridge console (loopback only, see console.ts) shares the remote's look.
export const consolePage=consoleHtml as unknown as string,consoleScript:string=consoleJs,consoleStyles:string=consoleCss;
// The app's crow icon (128 px, rounded like the home-screen icon), for the console and the web remote.
// It identifies the app: the Apache License grants no permission to use it as a trademark (section 6).
export const appIcon:Uint8Array=new Uint8Array(readFileSync(iconFile));
// The map file is not shipped; drop the reference so browsers don't ask for it.
// Browsers receive a copy of xterm.js, so its MIT notice travels with it.
export const xtermScript:string=`/*! xterm.js 5.5.0\n${String(xtermLicense).replaceAll("*/","* /").trim()}\n*/\n`+xterm.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/,"\n");
