// Terminal output for people: colour, symbols, aligned fields, tables and boxes (openspec/changes/polish-bridge-cli).
// Scripts keep JSON: `human` is false when the stream isn't a terminal or --json was given, and then commands print
// exactly what they printed before. Colour follows NO_COLOR, FORCE_COLOR and TERM=dumb.
import { homedir } from "node:os";

type Env = Record<string, string | undefined>;
export interface Stream { isTTY?: boolean; columns?: number; write(text: string): unknown }
export type Level = 0 | 1 | 2 | 3;

/** 0 none, 1 the 16 basic colours, 2 256 colours, 3 24-bit. */
export function colourLevel(stream: { isTTY?: boolean }, env: Env = process.env): Level {
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return 0;
    return Math.max(force === "2" ? 2 : force === "3" ? 3 : 1, depth(env)) as Level;
  }
  if (env.NO_COLOR) return 0;
  if (!stream.isTTY || env.TERM === "dumb") return 0;
  return depth(env);
}
function depth(env: Env): Level {
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") || env.WT_SESSION || ["iTerm.app", "WezTerm", "vscode", "ghostty"].includes(env.TERM_PROGRAM ?? "")) return 3;
  if (/256/.test(env.TERM ?? "") || env.TERM_PROGRAM === "Apple_Terminal") return 2;
  return 1;
}

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
function ansi256([r, g, b]: [number, number, number]) {
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : Math.round((r - 8) / 247 * 24) + 232;
  return 16 + 36 * Math.round(r / 255 * 5) + 6 * Math.round(g / 255 * 5) + Math.round(b / 255 * 5);
}
export type Paint = (text: string) => string;
/** The app icon's indigo and lavender, and status colours that read on light and dark terminals. */
export function palette(level: Level) {
  const wrap = (open: string, close: string): Paint => text => level && text ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  const colour = (hex: string, basic: number): Paint => {
    const value = rgb(hex);
    return wrap(level === 3 ? `38;2;${value.join(";")}` : level === 2 ? `38;5;${ansi256(value)}` : String(basic), "39");
  };
  return {
    // Bold and dim both end with 22, so text bolded inside dim turns dim on again after it.
    level, bold: wrap("1", "22"), dim: (text: string) => wrap("2", "22")(level ? text.replaceAll("\x1b[22m", "\x1b[22m\x1b[2m") : text), italic: wrap("3", "23"), underline: wrap("4", "24"),
    accent: colour("#6871ef", 94), lavender: colour("#9ea4f7", 95),
    green: colour("#3fb950", 32), yellow: colour("#d29922", 33), red: colour("#f85149", 31), cyan: colour("#39c5cf", 36),
  };
}
export type Palette = ReturnType<typeof palette>;

export function symbols(env: Env = process.env) {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  const unicode = env.TERM !== "dumb" && (locale === "" || /UTF-?8/i.test(locale));
  return unicode
    ? { ok: "✓", fail: "✗", warn: "!", info: "●", brand: "◆", arrow: "→", bullet: "•", dot: "·", ellipsis: "…", box: ["╭", "╮", "╰", "╯", "─", "│"] }
    : { ok: "+", fail: "x", warn: "!", info: "*", brand: "*", arrow: "->", bullet: "-", dot: "-", ellipsis: "...", box: ["+", "+", "+", "+", "-", "|"] };
}

const ESCAPES = /\x1b\[[0-9;]*m/g;
export const strip = (text: string) => text.replace(ESCAPES, "");
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u;
/** Columns a string takes on a terminal (escape sequences take none, CJK and emoji two). */
export function width(text: string) { let n = 0; for (const ch of strip(text)) n += WIDE.test(ch) ? 2 : 1; return n; }
export const pad = (text: string, columns: number) => text + " ".repeat(Math.max(0, columns - width(text)));
/** Words wrapped to `columns` (escape sequences don't count), continuation lines indented like the first. */
export function wrapText(text: string, columns: number, indent = /^ */.exec(text)![0]): string[] {
  const lines: string[] = []; let line = "", used = 0;
  for (const word of text.trimStart().split(" ")) {
    const w = width(word);
    if (line && indent.length + used + 1 + w > columns) { lines.push(indent + line); line = word; used = w; }
    else { line = line ? `${line} ${word}` : word; used += (used ? 1 : 0) + w; }
  }
  lines.push(indent + line);
  return lines;
}

/** A home-relative path, the way people type it. */
export function tilde(path: string, home = homedir()) { return home && (path === home || path.startsWith(home + "/")) ? "~" + path.slice(home.length) : path; }

// "tomorrow" and "yesterday" read well; "next year" for a certificate a year away doesn't, so years and months use numbers.
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" }), counted = new Intl.RelativeTimeFormat("en", { numeric: "always" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
/** "in 5 minutes", "yesterday", "just now". */
export function ago(at: number, now = Date.now()) {
  const seconds = (at - now) / 1000;
  if (Math.abs(seconds) < 45) return seconds >= 0 ? "in a few seconds" : "just now";
  for (const [unit, size] of UNITS) if (Math.abs(seconds) >= size * 0.95) return (unit === "year" || unit === "month" ? counted : relative).format(Math.round(seconds / size), unit);
  return relative.format(Math.round(seconds / 60), "minute");
}
/** "14:05" today, "11 Nov 14:05" this year, "11 Nov 2027" otherwise; the computer's time zone. */
export function when(at: number, now = Date.now(), timeZone?: string) {
  const date = new Date(at), today = new Date(now);
  const part = (o: Intl.DateTimeFormatOptions, d = date) => new Intl.DateTimeFormat("en-GB", { ...o, timeZone }).format(d);
  const day = { day: "numeric", month: "short" } as const, time = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  if (part({ year: "numeric" }) !== part({ year: "numeric" }, today)) return part({ ...day, year: "numeric" });
  if (part(day) === part(day, today)) return part(time);
  return `${part(day)} ${part(time)}`;
}
/** A certificate fingerprint in groups of four, `lines` of eight groups (64 hex digits = 2 lines). */
export function fingerprint(pin: string, short = false) {
  const groups = pin.toLowerCase().match(/.{1,4}/g) ?? [];
  if (short) return groups.slice(0, 2).join("-");
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += 8) lines.push(groups.slice(i, i + 8).join(" "));
  return lines.join("\n");
}

export interface Terminal {
  /** Styled text for a person (a terminal, no --json); otherwise print what scripts expect. */
  human: boolean;
  c: Palette;
  sym: ReturnType<typeof symbols>;
  columns: number;
  line(text?: string): void;
  ok(text: string): void;
  warn(text: string): void;
  fail(text: string): void;
  info(text: string): void;
  step(text: string): void;
  heading(text: string, detail?: string): void;
  hint(text: string): void;
  /** Label/value pairs with the values aligned; undefined values are left out, multi-line values stay aligned. */
  fields(rows: [string, string | undefined | false][], indent?: number): void;
  table(head: string[], rows: string[][], o?: { indent?: number; dim?: boolean[] }): void;
  box(lines: string[], o?: { paint?: Paint }): void;
  /** A command the person might type next. */
  command(text: string): string;
}
export function terminal(stream: Stream = process.stdout, o: { json?: boolean; env?: Env } = {}): Terminal {
  const env = o.env ?? process.env, c = palette(colourLevel(stream, env)), sym = symbols(env);
  // Through console for the real streams: it ignores a reader that went away (`agent-remote --help | head`), where
  // process.stdout.write ends the program with an EPIPE stack trace.
  const write = stream === process.stdout ? (text = "") => console.log(text) : stream === process.stderr ? (text = "") => console.error(text) : (text = "") => { stream.write(text + "\n"); };
  // Prose wraps at the terminal's width, and at 100 columns on a wide one so it stays readable.
  const columns = stream.columns || 80, prose = Math.min(columns, 100);
  const marked = (mark: string, text: string) => wrapText(text, prose - 2, "").forEach((line, i) => write(`${i ? " " : mark} ${line}`));
  const t: Terminal = {
    human: !o.json && !!stream.isTTY, c, sym, columns,
    line: write,
    ok: text => marked(c.green(sym.ok), text),
    warn: text => marked(c.yellow(c.bold(sym.warn)), text),
    fail: text => marked(c.red(sym.fail), text),
    info: text => marked(c.accent(sym.info), text),
    step: text => marked(c.dim(sym.bullet), text),
    heading: (text, detail) => write(`${c.accent(sym.brand)} ${c.bold(text)}${detail ? c.dim(` ${sym.dot} ${detail}`) : ""}`),
    hint: text => { for (const line of wrapText(text, prose)) write(c.dim(line)); },
    fields(rows, indent = 2) {
      const shown = rows.filter((row): row is [string, string] => typeof row[1] === "string");
      const labels = Math.max(0, ...shown.map(([label]) => width(label)));
      for (const [label, value] of shown) {
        const [first, ...rest] = value.split("\n");
        write(`${" ".repeat(indent)}${c.dim(pad(label, labels))}  ${first}`);
        for (const more of rest) write(`${" ".repeat(indent + labels + 2)}${more}`);
      }
    },
    table(head, rows, opts = {}) {
      const indent = " ".repeat(opts.indent ?? 2), widths = head.map((h, i) => Math.max(width(h), ...rows.map(r => width(r[i] ?? ""))));
      const join = (cells: string[]) => cells.map((cell, i) => i === cells.length - 1 ? cell : pad(cell, widths[i]!)).join("  ").trimEnd();
      write(indent + c.dim(join(head)));
      rows.forEach((row, i) => write(indent + (opts.dim?.[i] ? c.dim(join(row.map(strip))) : join(row))));
    },
    box(lines, opts = {}) {
      const paint = opts.paint ?? c.accent, [tl, tr, bl, br, h, v] = sym.box as string[];
      const inner = Math.max(...lines.map(width)) + 4;
      write(paint(tl + h.repeat(inner) + tr));
      for (const text of lines) write(`${paint(v)}  ${pad(text, inner - 4)}  ${paint(v)}`);
      write(paint(bl + h.repeat(inner) + br));
    },
    command: text => c.accent(text),
  };
  return t;
}
