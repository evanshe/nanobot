import { BlockList, isIP } from 'node:net';
// Python ipaddress.is_private ranges (including reserved/documentation ranges),
// plus its explicit exceptions. This is routing behavior, not an HTTP allowlist.
const privateNetworks = new BlockList(), exceptions = new BlockList();
for (const cidr of ['0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '240.0.0.0/4', '::1/128', '::/128', '64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20', 'fc00::/7', 'fe80::/10']) {
  const [address, bits] = cidr.split('/'); privateNetworks.addSubnet(address, Number(bits), address.includes(':') ? 'ipv6' : 'ipv4');
}
for (const cidr of ['192.0.0.9/32', '192.0.0.10/32', '2001:1::1/128', '2001:1::2/128', '2001:3::/32', '2001:4:112::/48', '2001:20::/28', '2001:30::/28']) {
  const [address, bits] = cidr.split('/'); exceptions.addSubnet(address, Number(bits), address.includes(':') ? 'ipv6' : 'ipv4');
}
export function isLocalChatEndpoint(apiBase: string): boolean {
  // Preserve the source hostname: WHATWG URL would first repair abbreviated
  // IPv4 or trailing-dot spellings that Python urlparse/ip_address do not.
  const raw = apiBase.trim().toLowerCase(), authority = raw.replace(/^[^:/?#]+:\/\//, '').replace(/^\/\//, '').split(/[/?#]/, 1)[0].split('@').at(-1)!;
  let host = authority.startsWith('[') ? authority.slice(1, authority.indexOf(']')) : authority.split(':', 1)[0];
  if (host === 'localhost' || host === 'host.docker.internal') return true;
  host = host.split('%', 1)[0];
  const version = isIP(host); if (!version) return false;
  if (version === 6) {
    // Canonicalize IPv4-mapped forms, whose private flag comes from IPv4.
    const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    if (mapped) {
      const [a, b] = mapped.slice(1).map(part => Number.parseInt(part, 16));
      host = `${a >>> 8}.${a & 255}.${b >>> 8}.${b & 255}`;
    }
  }
  const family = isIP(host) === 4 ? 'ipv4' : 'ipv6';
  return privateNetworks.check(host, family) && !exceptions.check(host, family);
}
