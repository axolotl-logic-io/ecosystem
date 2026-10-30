// Text posted to GitHub names no IP address (#385): each IPv4 address, with
// or without a port, and each IPv6 address, bare or bracketed with a port,
// reads `[redacted]`, its port included. Times, ISO times, SHAs and versions
// such as v1.2.3 are kept.

const REDACTED = "[redacted]";

// Bracketed IPv6, as in a URL or a socket address, with its port if any.
const IPV6_BRACKETED: RegExp =
  /\[(?<inside>[0-9a-f:.]*:[0-9a-f:.]*)\](?::\d{1,5})?/giu;
// A candidate bare IPv6 address: two to eight colon-separated hex groups,
// not part of a longer word or colon run.
const IPV6: RegExp =
  /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/giu;
const IPV4: RegExp =
  /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\w]|\.\d)/gu;
const HEX_DIGIT: RegExp = /[0-9a-f]/iu;
const HEX_LETTER: RegExp = /[a-f]/iu;
const COLON = ":";
const FULL_GROUPS = 8;
// Two colons make three groups.
const MIN_GROUPS = 3;

// Whether a candidate is an IPv6 address rather than a time such as 01:02:03:
// it has a hex digit and at least two colons, and also a hex letter, a `::`,
// or all eight groups.
function isIpv6(candidate: string): boolean {
  const groups = candidate.split(COLON).length;
  if (!HEX_DIGIT.test(candidate) || groups < MIN_GROUPS) {
    return false;
  }
  return (
    HEX_LETTER.test(candidate) ||
    candidate.includes("::") ||
    groups === FULL_GROUPS
  );
}

function redactIpv6(match: string): string {
  if (isIpv6(match)) {
    return REDACTED;
  }
  return match;
}

// A bracketed match, with its port, goes whole when its inside is an address.
function redactBracketed(match: string, inside: string): string {
  if (isIpv6(inside)) {
    return REDACTED;
  }
  return match;
}

// `text` with every IP address shown as `[redacted]`.
function redactAddresses(text: string): string {
  return text
    .replace(IPV6_BRACKETED, redactBracketed)
    .replace(IPV6, redactIpv6)
    .replace(IPV4, REDACTED);
}

export { redactAddresses };
