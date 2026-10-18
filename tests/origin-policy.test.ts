import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginPolicy } from '../server/origin-policy.js';

const backendHost = '127.0.0.1:3000';

test('gateway origins are disabled by default while direct local and development access stay available', () => {
  const allows = createOriginPolicy();
  for (const origin of ['http://127.0.0.1:3000', 'http://localhost:5173', 'http://[::1]:5174']) {
    assert.equal(allows(origin, backendHost), true, origin);
  }
  for (const origin of ['http://127.0.0.1:8888', 'http://192.168.0.135:8888', 'http://10.8.0.5:8888']) {
    assert.equal(allows(origin, backendHost), false, origin);
  }
});

test('one running origin policy follows LAN address changes without retaining the old address', () => {
  let addresses = ['127.0.0.1', '192.168.0.135'];
  const allows = createOriginPolicy([], {ports:[8888], localAddresses:() => addresses});
  const oldOrigin = 'http://192.168.0.135:8888';
  const newOrigin = 'http://192.168.1.42:8888';
  assert.equal(allows(oldOrigin, backendHost), true);
  assert.equal(allows(newOrigin, backendHost), false);
  addresses = ['127.0.0.1', '192.168.1.42'];
  assert.equal(allows(oldOrigin, backendHost), false);
  assert.equal(allows(newOrigin, backendHost), true);
  addresses = [];
  assert.equal(allows(newOrigin, backendHost), false);
});

test('the configured VPN subnet accepts every last octet and excludes neighboring networks', () => {
  const allows = createOriginPolicy([], {ports:[8888], subnets:['10.8.0.0/24'], localAddresses:() => []});
  for (let last = 0; last <= 255; last++) {
    const origin = `http://10.8.0.${last}:8888`;
    assert.equal(allows(origin, backendHost), true, origin);
  }
  for (const address of ['10.7.255.255', '10.8.1.0', '10.8.1.5', '10.8.255.255', '10.9.0.5', '192.168.0.135', '172.16.0.1', '8.8.8.8']) {
    assert.equal(allows(`http://${address}:8888`, backendHost), false, address);
  }
});

test('dynamic local and VPN origins are restricted to configured HTTP gateway ports', () => {
  const allows = createOriginPolicy([], {ports:[8888, 9999], subnets:['10.8.0.0/24'], localAddresses:() => ['192.168.1.42']});
  for (const host of ['localhost', '127.0.0.1', '[::1]', '192.168.1.42', '10.8.0.5']) {
    for (const port of [8888, 9999]) assert.equal(allows(`http://${host}:${port}`, backendHost), true);
    for (const origin of [`http://${host}:8889`, `http://${host}`, `https://${host}:8888`, `https://${host}`]) {
      assert.equal(allows(origin, backendHost), false, origin);
    }
  }
  const defaultPort = createOriginPolicy([], {ports:[80], subnets:['10.8.0.0/24']});
  assert.equal(defaultPort('http://10.8.0.5', backendHost), true);
  assert.equal(defaultPort('http://10.8.0.5:80', backendHost), false);
});

test('gateway origin validation rejects URL additions, malformed input and domain lookalikes', () => {
  const allows = createOriginPolicy([], {ports:[8888], subnets:['10.8.0.0/24'], localAddresses:() => ['192.168.1.42']});
  for (const origin of [
    '', 'null', 'undefined', '*', '10.8.0.5:8888', '//10.8.0.5:8888',
    'http://user@10.8.0.5:8888', 'http://user:password@10.8.0.5:8888',
    'http://10.8.0.5:8888/', 'http://10.8.0.5:8888/path',
    'http://10.8.0.5:8888?query=1', 'http://10.8.0.5:8888#fragment',
    'http://10.8.0.5.evil.example:8888', 'http://192.168.1.42.evil.example:8888',
    'http://localhost.evil.example:8888', 'http://evil.example:8888',
    'http://10.8.0.5:8888 http://evil.example', 'http://10.8.0.5:8888,http://evil.example',
    ' http://10.8.0.5:8888', 'http://10.8.0.5:8888\n', 'HTTP://10.8.0.5:8888',
    'ftp://10.8.0.5:8888', 'file://10.8.0.5:8888',
    'http://10.8.0.5:0', 'http://10.8.0.5:65536', 'http://10.8.0.5:port',
  ]) assert.equal(allows(origin, backendHost), false, JSON.stringify(origin));
});

test('noncanonical IP spellings cannot disguise a permitted gateway address', () => {
  const allows = createOriginPolicy([], {ports:[8888], subnets:['10.8.0.0/24'], localAddresses:() => []});
  for (const origin of [
    'http://10.8.5:8888', 'http://10.524293:8888', 'http://168296453:8888',
    'http://0x0a080005:8888', 'http://0x0a.8.0.5:8888', 'http://012.010.0.5:8888',
    'http://10.8.0.005:8888', 'http://10.8.0.5.:8888', 'http://%31%30.8.0.5:8888',
    'http://[::ffff:10.8.0.5]:8888', 'http://10.8.0.5:08888',
  ]) assert.equal(allows(origin, backendHost), false, origin);
});

test('explicit origins preserve HTTPS and custom host support without bypassing URL validation', () => {
  const trusted = ['https://flomo.example.test', 'http://10.8.1.5:7777', 'http://192.168.0.135:8888'];
  const allows = createOriginPolicy([...trusted, 'http://user@10.8.0.5:8888', 'http://10.8.0.5:8888/path', 'null'], {
    ports:[8888], subnets:['10.8.0.0/24'], localAddresses:() => [],
  });
  for (const origin of trusted) assert.equal(allows(origin, backendHost), true, origin);
  for (const origin of [
    'http://flomo.example.test', 'https://flomo.example.test:8888', 'https://flomo.example.test.evil.example',
    'http://10.8.1.5:8888', 'http://192.168.0.136:8888',
    'http://user@10.8.0.5:8888', 'http://10.8.0.5:8888/path', 'null',
  ]) assert.equal(allows(origin, backendHost), false, origin);
});

test('invalid gateway ports and CIDRs fail configuration instead of widening access', () => {
  for (const port of [0, -1, 65536, 8888.5, NaN, Infinity]) {
    assert.throws(() => createOriginPolicy([], {ports:[port]}), /端口/, String(port));
  }
  for (const subnet of [
    '', '10.8.0.0', '10.8.0.0/', '10.8.0.0/-1', '10.8.0.0/33', '10.8.0.0/24.5',
    '10.8.0.0/255.255.255.0', '10.8.0.0/24/24', '10.8.0.256/24', '10.8.0.5/24',
    '10.8.1.0/16', '10.8.0.0/0', '010.8.0.0/24', '0x0a080000/24',
    '10.8.0.0.evil.example/24', '::1/128', ' 10.8.0.0/24', '10.8.0.0/24 ',
  ]) assert.throws(() => createOriginPolicy([], {ports:[8888], subnets:[subnet]}), /网段/, subnet);
  assert.throws(() => createOriginPolicy([], {ports:[], subnets:['10.8.0.0/24']}), /网关端口/);
});

test('IPv4 CIDR boundaries work for individual hosts and addresses above the signed integer range', () => {
  const allows = createOriginPolicy([], {ports:[8888], subnets:['10.8.0.5/32', '192.168.2.0/31'], localAddresses:() => []});
  for (const address of ['10.8.0.5', '192.168.2.0', '192.168.2.1']) {
    assert.equal(allows(`http://${address}:8888`, backendHost), true, address);
  }
  for (const address of ['10.8.0.4', '10.8.0.6', '192.168.1.255', '192.168.2.2']) {
    assert.equal(allows(`http://${address}:8888`, backendHost), false, address);
  }
});
