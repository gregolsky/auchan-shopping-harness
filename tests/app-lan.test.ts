import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAppServer, createBroadcaster, lanAddresses, listenAlso, qrSvg } from '../src/app/server.ts';

const TOKEN = 'b'.repeat(32);
const LAN = '192.168.1.23';

async function start(lanHosts: string[]) {
  const publicDir = mkdtempSync(join(tmpdir(), 'pub-'));
  writeFileSync(join(publicDir, 'index.html'), '<html>hi</html>');
  let syncs = 0;
  const service = { sync: () => { syncs++; return {}; } } as never;
  const server = createAppServer({ service, token: TOKEN, publicDir, broadcaster: createBroadcaster(), lanHosts });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { port, syncs: () => syncs, close: () => { server.closeAllConnections(); server.close(); } };
}

/** A request to the loopback socket that claims another Host, as a phone on the Wi-Fi would send it. */
function request(port: number, host: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host, ...opts.headers } }, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => resolve({ status: r.statusCode ?? 0, type: String(r.headers['content-type']), body }));
    });
    q.on('error', reject);
    q.end(opts.body);
  });
}

test('lanAddresses keeps only private IPv4 addresses of real interfaces', () => {
  const a = (address: string, family = 'IPv4', internal = false) => ({ address, family, internal, netmask: '', mac: '', cidr: null });
  const got = lanAddresses({
    lo: [a('127.0.0.1', 'IPv4', true)],
    wlan0: [a('192.168.1.23'), a('fe80::1', 'IPv6')],
    eth0: [a('10.0.0.5')],
    wan: [a('83.12.1.1')],
    odd: [a('172.32.0.1'), a('192.169.0.1')],
    usb0: [a('172.20.10.2')],
  } as never);
  assert.deepEqual(got, ['192.168.1.23', '10.0.0.5', '172.20.10.2']);
});

test('lanAddresses puts the home Wi-Fi range first and skips container and VPN interfaces', () => {
  const a = (address: string) => ({ address, family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null });
  const got = lanAddresses({
    docker0: [a('172.17.0.1')], 'br-1a2b': [a('172.18.0.1')], veth0: [a('10.1.0.1')], virbr0: [a('192.168.122.1')], wg0: [a('10.8.0.2')],
    eth1: [a('10.0.0.5')], wlp0s20f3: [a('192.168.60.122')],
  } as never);
  assert.deepEqual(got, ['192.168.60.122', '10.0.0.5']);
});

test('the page answers on a LAN address the server was given, and on nothing else', async () => {
  const s = await start([LAN]);
  try {
    assert.equal((await request(s.port, `${LAN}:${s.port}`, `/?t=${TOKEN}`)).status, 200);
    assert.equal((await request(s.port, `${LAN}:${s.port}`, '/?t=wrong')).status, 403);
    assert.equal((await request(s.port, `192.168.1.99:${s.port}`, `/?t=${TOKEN}`)).status, 403);
  } finally { s.close(); }
});

test('without LAN hosts a LAN Host header is refused', async () => {
  const s = await start([]);
  try {
    assert.equal((await request(s.port, `${LAN}:${s.port}`, `/?t=${TOKEN}`)).status, 403);
  } finally { s.close(); }
});

test('a POST from the phone needs the phone origin, not another one', async () => {
  const s = await start([LAN]);
  try {
    const headers = (origin: string) => ({ 'x-app-token': TOKEN, 'content-type': 'application/json', origin });
    const ok = await request(s.port, `${LAN}:${s.port}`, '/api/sync', { method: 'POST', headers: headers(`http://${LAN}:${s.port}`), body: '{}' });
    assert.equal(ok.status, 200);
    const cross = await request(s.port, `${LAN}:${s.port}`, '/api/sync', { method: 'POST', headers: headers(`http://127.0.0.1:${s.port}`), body: '{}' });
    assert.equal(cross.status, 403);
    assert.equal(s.syncs(), 1);
  } finally { s.close(); }
});

test('/api/phone gives the phone link, /phone-qr.svg its QR code; both need the token', async () => {
  const s = await start([LAN]);
  const local = `127.0.0.1:${s.port}`;
  try {
    const info = await request(s.port, local, `/api/phone?t=${TOKEN}`);
    assert.equal(info.status, 200);
    assert.deepEqual(JSON.parse(info.body), { url: `http://${LAN}:${s.port}/?t=${TOKEN}` });
    const qr = await request(s.port, local, `/phone-qr.svg?t=${TOKEN}`);
    assert.equal(qr.status, 200);
    assert.equal(qr.type, 'image/svg+xml');
    assert.match(qr.body, /^<svg[^>]*viewBox/);
    for (const p of ['/api/phone', '/phone-qr.svg', '/api/phone?t=wrong']) assert.equal((await request(s.port, local, p)).status, 403, p);
    const post = await request(s.port, local, `/api/phone?t=${TOKEN}`, { method: 'POST', headers: { 'x-app-token': TOKEN, 'content-type': 'application/json', origin: `http://${local}` }, body: '{}' });
    assert.notEqual(post.status, 200, 'the phone link is only for GET');
  } finally { s.close(); }
});

test('without a LAN address /api/phone says so and there is no QR code', async () => {
  const s = await start([]);
  try {
    const local = `127.0.0.1:${s.port}`;
    assert.deepEqual(JSON.parse((await request(s.port, local, `/api/phone?t=${TOKEN}`)).body), { url: null });
    assert.equal((await request(s.port, local, `/phone-qr.svg?t=${TOKEN}`)).status, 404);
  } finally { s.close(); }
});

test('qrSvg makes one scalable SVG and nothing else', () => {
  const svg = qrSvg('http://192.168.1.23:47474/?t=' + TOKEN);
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"[^>]*>[\s\S]*<\/svg>$/);
  assert.doesNotMatch(svg, /<script|on\w+=/i);
});

test('listenAlso serves the same app on one more address and port, and only there', async () => {
  const publicDir = mkdtempSync(join(tmpdir(), 'pub-'));
  writeFileSync(join(publicDir, 'index.html'), '<html>hi</html>');
  const lanHost = '127.0.0.2'; // a second loopback address stands in for the Wi-Fi one
  const app = createAppServer({ service: {} as never, token: TOKEN, publicDir, broadcaster: createBroadcaster(), lanHosts: [lanHost] });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const port = (app.address() as AddressInfo).port;
  const extra = await listenAlso(app, port, lanHost);
  try {
    assert.equal((extra.address() as AddressInfo).address, lanHost);
    const r = await fetch(`http://${lanHost}:${port}/?t=${TOKEN}`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '<html>hi</html>');
    await assert.rejects(fetch(`http://127.0.0.3:${port}/?t=${TOKEN}`), 'nothing listens on other addresses');
  } finally {
    extra.closeAllConnections(); extra.close(); app.closeAllConnections(); app.close();
  }
});
