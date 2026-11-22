// Tiny stack VM for make.fun's tiny-stack-vm-01: runs every program of a set
// (i001..i040) on the kit's 32-bit stack ISA, writing each answer to /output.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Per opcode: [immediate bytes, values popped, values pushed].
const META: { [op: number]: [number, number, number] } = {
  0x00: [0, 0, 0], 0x01: [1, 0, 1], 0x02: [4, 0, 1], 0x03: [0, 1, 0],
  0x04: [0, 1, 2], 0x05: [0, 2, 2], 0x06: [0, 2, 3], 0x07: [0, 3, 3],
  0x10: [0, 2, 1], 0x11: [0, 2, 1], 0x12: [0, 2, 1], 0x13: [0, 2, 1],
  0x14: [0, 2, 1], 0x15: [0, 2, 1], 0x16: [0, 2, 1], 0x17: [0, 1, 1],
  0x18: [0, 2, 1], 0x19: [0, 2, 1], 0x1a: [0, 2, 1], 0x1b: [0, 1, 1],
  0x1c: [0, 2, 1], 0x1d: [0, 2, 1], 0x1e: [0, 2, 1],
  0x20: [0, 2, 1], 0x21: [0, 2, 1], 0x22: [0, 2, 1],
  0x30: [2, 0, 0], 0x31: [2, 1, 0], 0x32: [2, 1, 0], 0x33: [2, 0, 0],
  0x34: [0, 0, 0], 0x40: [0, 1, 1], 0x41: [0, 2, 0],
  0x50: [0, 1, 0], 0x51: [0, 1, 0], 0x52: [0, 0, 1], 0x53: [0, 1, 0],
};

// Runs one program on its input bytes; returns the bytes it wrote and the
// exit code it ended with (a trap's code included).
function run(p: Buffer, input: Buffer): { out: Uint8Array; exit: number } {
  const st = new Int32Array(256); // data stack
  let sp = 0;
  const cs = new Int32Array(64); // call stack
  let cp = 0;
  const mem = new Int32Array(256); // memory, 256 words, zero at start
  const out = new Uint8Array(65536);
  let ol = 0;
  let ip = 0;
  let pc = 0;
  let steps = 0;
  const end = (exit: number) => ({ out: out.slice(0, ol), exit });

  for (;;) {
    if (steps === 1000000) return end(10); // step limit, checked first
    if (pc < 0 || pc >= p.length) return end(9);
    const op = p[pc];
    const m = META[op];
    if (!m) return end(5);
    const [imm, pops, pushes] = m;
    if (pc + imm >= p.length) return end(9);
    steps++;
    const nx = pc + 1 + imm; // next instruction's address
    if (sp < pops) return end(2);
    if (sp - pops + pushes > 256) return end(3);
    pc = nx;
    switch (op) {
      case 0x00:
        return end(0);
      case 0x01: // PUSH8: byte as a signed 8-bit number
        st[sp++] = (p[nx - 1] << 24) >> 24;
        break;
      case 0x02: // PUSH32: four bytes, little-endian, signed
        st[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24);
        break;
      case 0x03:
        sp--;
        break;
      case 0x04:
        st[sp] = st[sp - 1];
        sp++;
        break;
      case 0x05: {
        const t = st[sp - 1];
        st[sp - 1] = st[sp - 2];
        st[sp - 2] = t;
        break;
      }
      case 0x06:
        st[sp] = st[sp - 2];
        sp++;
        break;
      case 0x07: {
        const t = st[sp - 3];
        st[sp - 3] = st[sp - 2];
        st[sp - 2] = st[sp - 1];
        st[sp - 1] = t;
        break;
      }
      case 0x17: // NEG wraps: -(-2147483648) stays -2147483648
        st[sp - 1] = (-st[sp - 1]) | 0;
        break;
      case 0x1b:
        st[sp - 1] = ~st[sp - 1];
        break;
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15:
      case 0x16: case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d:
      case 0x1e: case 0x20: case 0x21: case 0x22: {
        const b = st[sp - 1];
        const a = st[sp - 2];
        let r = 0;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b); // low 32 bits of product
        else if (op === 0x13) {
          if (b === 0) return end(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 0x14) {
          if (b === 0) return end(4);
          r = b === -1 ? 0 : (a % b) | 0; // remainder takes sign of a
        } else if (op === 0x15) {
          if (b === 0) return end(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 0x16) {
          if (b === 0) return end(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        sp -= 2;
        st[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: {
        // Signed 16-bit offset from the next instruction.
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) {
          const v = st[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = nx + rel;
        break;
      }
      case 0x33: // CALL: unsigned 16-bit target
        if (cp === 64) return end(7);
        cs[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34:
        if (cp === 0) return end(8);
        pc = cs[--cp];
        break;
      case 0x40: {
        const addr = st[sp - 1];
        if (addr < 0 || addr > 255) return end(6);
        st[sp - 1] = mem[addr];
        break;
      }
      case 0x41: {
        const addr = st[sp - 1];
        const v = st[sp - 2];
        if (addr < 0 || addr > 255) return end(6);
        sp -= 2;
        mem[addr] = v;
        break;
      }
      case 0x50: {
        // PRINT writes decimal ASCII; a print past the output limit writes
        // none of its bytes and traps.
        const s = String(st[sp - 1]);
        if (ol + s.length > 65536) return end(11);
        sp--;
        for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51:
        if (ol + 1 > 65536) return end(11);
        out[ol++] = st[--sp] & 255;
        break;
      case 0x52: // IN: -1 once the input is used up
        st[sp++] = ip < input.length ? input[ip++] : -1;
        break;
      case 0x53: // EXIT: low byte of the value
        return end(st[--sp] & 255);
    }
  }
}

for (const id of readdirSync(IN_DIR).sort()) {
  const prog = readFileSync(join(IN_DIR, id, 'program.bin'));
  const input = readFileSync(join(IN_DIR, id, 'input.bin'));
  const { out, exit } = run(prog, input);
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'stdout.bin'), out);
  writeFileSync(join(OUT_DIR, id, 'exit.txt'), String(exit) + '\n');
}
