// Files the web remote imports as text (Bun `with {type:"text"}`).
declare module "*.html" {const text:string;export default text;}
declare module "*.css" {const text:string;export default text;}
declare module "@xterm/xterm/lib/xterm.js" {const text:string;export default text;}
declare module "*/console.js" { const text: string; export default text; }
declare module "*/remote.js" {const text:string;export default text;}
declare module "*.txt" {const text:string;export default text;}
// Binary files embedded with `with {type:"file"}`: the import is a path Bun reads (from $bunfs in a compiled binary).
declare module "*.png" {const path:string;export default path;}
