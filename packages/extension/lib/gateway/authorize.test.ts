import { describe, it, expect } from 'vitest';
import { parseHttpUrl, isBlockedHost } from './authorize';

describe('parseHttpUrl', () => {
  it('parses an https URL into origin / host / pathname', () => {
    expect(parseHttpUrl('https://api.com/v1/user?id=1')).toEqual({
      origin: 'https://api.com',
      host: 'api.com',
      pathname: '/v1/user',
    });
  });

  it('accepts http', () => {
    expect(parseHttpUrl('http://example.com')?.origin).toBe('http://example.com');
  });

  it('rejects non-http(s) schemes', () => {
    expect(parseHttpUrl('ftp://example.com')).toBeNull();
    expect(parseHttpUrl('file:///etc/passwd')).toBeNull();
    expect(parseHttpUrl('javascript:alert(1)')).toBeNull();
    expect(parseHttpUrl('data:text/plain,hi')).toBeNull();
  });

  it('rejects a malformed URL', () => {
    expect(parseHttpUrl('not a url')).toBeNull();
    expect(parseHttpUrl('')).toBeNull();
  });
});

describe('isBlockedHost — SSRF guard', () => {
  it('blocks localhost and its subdomains', () => {
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('LOCALHOST')).toBe(true);
    expect(isBlockedHost('foo.localhost')).toBe(true);
    expect(isBlockedHost('localhost.')).toBe(true); // trailing dot
  });

  it('blocks .local and .internal suffixes', () => {
    expect(isBlockedHost('printer.local')).toBe(true);
    expect(isBlockedHost('db.internal')).toBe(true);
  });

  it('blocks IPv4 loopback (127.0.0.0/8)', () => {
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('127.1.2.3')).toBe(true);
  });

  it('blocks 0.0.0.0/8', () => {
    expect(isBlockedHost('0.0.0.0')).toBe(true);
  });

  it('blocks RFC1918 private ranges', () => {
    expect(isBlockedHost('10.0.0.1')).toBe(true);
    expect(isBlockedHost('192.168.1.1')).toBe(true);
    expect(isBlockedHost('172.16.0.1')).toBe(true);
    expect(isBlockedHost('172.31.255.255')).toBe(true);
  });

  it('does NOT block 172.x outside 16–31', () => {
    expect(isBlockedHost('172.15.0.1')).toBe(false);
    expect(isBlockedHost('172.32.0.1')).toBe(false);
  });

  it('blocks link-local incl. the cloud metadata endpoint', () => {
    expect(isBlockedHost('169.254.169.254')).toBe(true);
    expect(isBlockedHost('169.254.0.1')).toBe(true);
  });

  it('blocks IPv6 loopback / unspecified', () => {
    expect(isBlockedHost('::1')).toBe(true);
    expect(isBlockedHost('::')).toBe(true);
  });

  it('blocks IPv6 link-local (fe80::/10) and unique-local (fc00::/7)', () => {
    expect(isBlockedHost('fe80::1')).toBe(true);
    expect(isBlockedHost('fd00::1')).toBe(true);
    expect(isBlockedHost('fc00::1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 pointing at a private v4', () => {
    expect(isBlockedHost('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedHost('::ffff:192.168.0.1')).toBe(true);
  });

  it('refuses a malformed IPv4 literal rather than forwarding it', () => {
    expect(isBlockedHost('999.999.999.999')).toBe(true);
    expect(isBlockedHost('127.0.0.999')).toBe(true);
  });

  it('allows ordinary public hosts', () => {
    expect(isBlockedHost('api.com')).toBe(false);
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedHost('8.8.8.8')).toBe(false);
    expect(isBlockedHost('1.1.1.1')).toBe(false);
    // A public IPv6 (documentation range) must pass.
    expect(isBlockedHost('2001:db8::1')).toBe(false);
  });
});
