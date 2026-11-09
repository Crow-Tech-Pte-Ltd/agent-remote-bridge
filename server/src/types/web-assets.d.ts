// Files the web remote imports as text (Bun `with {type:"text"}`).
declare module "*.html" {const text:string;export default text;}
declare module "*.css" {const text:string;export default text;}
declare module "@xterm/xterm/lib/xterm.js" {const text:string;export default text;}
declare module "*/console.js" { const text: string; export default text; }
declare module "*/remote.js" {const text:string;export default text;}
declare module "*.txt" {const text:string;export default text;}
