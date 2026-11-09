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
export const remotePage=page as unknown as string,remoteScript:string=script,remoteStyles:string=styles,xtermStyles:string=xtermCss;
// The bridge console (loopback only, see console.ts) shares the remote's look.
export const consolePage=consoleHtml as unknown as string,consoleScript:string=consoleJs,consoleStyles:string=consoleCss;
export const remoteIcon=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1c1c1e"/><path d="M17 22l12 10-12 10" fill="none" stroke="#4cc27e" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M33 44h14" stroke="#ececef" stroke-width="6" stroke-linecap="round"/></svg>`;
// The map file is not shipped; drop the reference so browsers don't ask for it.
// Browsers receive a copy of xterm.js, so its MIT notice travels with it.
export const xtermScript:string=`/*! xterm.js 5.5.0\n${String(xtermLicense).replaceAll("*/","* /").trim()}\n*/\n`+xterm.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/,"\n");
