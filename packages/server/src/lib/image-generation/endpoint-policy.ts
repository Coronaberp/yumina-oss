import { isIP } from 'node:net';
/** Local-edition ComfyUI and Forge Neo profiles may target private hosts; hosted profiles remain public-only. */
export type EndpointPolicy = { allowPrivate: boolean };
function ipv6Words(address: string): number[] {
  let raw = address.toLowerCase();
  if (raw.includes('.')) {
    const tail = raw.slice(raw.lastIndexOf(':') + 1).split('.').map(Number);
    if (tail.length !== 4) return [];
    raw = raw.slice(0, raw.lastIndexOf(':') + 1) + ((tail[0]! << 8) | tail[1]!).toString(16) + ':' + ((tail[2]! << 8) | tail[3]!).toString(16);
  }
  const split = raw.split('::');
  const left = split[0] ? split[0].split(':').map(part => parseInt(part, 16)) : [];
  const right = split[1] ? split[1].split(':').map(part => parseInt(part, 16)) : [];
  return split.length === 2 ? [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right] : left;
}
/** Classify literal/resolved IPs, including compressed and embedded IPv4 IPv6 forms. */
export function allowedEndpointAddress(address: string, policy: EndpointPolicy): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
    // Unspecified, metadata/link-local and multicast/reserved addresses are never local provider targets.
    if (a === 0 || a === 169 && b === 254 || a >= 224 || address === '168.63.129.16' || address === '100.100.100.200') return false;
    if (policy.allowPrivate) return true;
    return !(a === 10 || a === 127 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
      a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) ||
      a === 192 && b === 0 && (c === 0 || c === 2) || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113);
  }
  if (family !== 6) return false;
  const words = ipv6Words(address);
  if (words.length !== 8 || words.some(Number.isNaN)) return false;
  const first = words[0]!;
  const zeroPrefix = words.slice(0, 6).every(word => word === 0);
  // Block multicast, link-local, unspecified, mapped/compatible IPv4 and tunnelling ranges.
  if ((first & 0xff00) === 0xff00 || (first & 0xffc0) === 0xfe80 || words.every(word => word === 0) ||
    words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff ||
    zeroPrefix && !(words[6] === 0 && words[7] === 1) || first === 0x2002 || first === 0x2001 && words[1] === 0 ||
    first === 0xfd00 && words[1] === 0xec2 && words.slice(2, 7).every(word => word === 0) && words[7] === 0x254) return false; // fd00:ec2::254 (AWS metadata)
  if (policy.allowPrivate) return true;
  // Global unicast, excluding documentation/benchmark/ORCHID allocations.
  return (first & 0xe000) === 0x2000 && !(first === 0x2001 && (words[1]! < 0x200 || words[1] === 0xdb8));
}
export function allowedEndpointHostname(hostname: string, policy: EndpointPolicy): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'metadata' || host === 'metadata.google.internal' || host.includes('%')) return false;
  if (isIP(host)) return allowedEndpointAddress(host, policy);
  if (!policy.allowPrivate && (host === 'localhost' || !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local'))) return false;
  return true;
}
