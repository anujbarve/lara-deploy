import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFixableDocumentRoot,
  parseDocumentRoots,
  parseInspection,
  stripSlash,
  vhostInspectScript,
  vhostRepairScript,
} from './vhost.js';

const APACHE_CONF = [
  '<VirtualHost *:80>',
  '    DocumentRoot "/www/wwwroot/example.com/current/public"',
  '    ServerName example.com',
  '</VirtualHost>',
  '<VirtualHost *:443>',
  '    DocumentRoot "/www/wwwroot/example.com/current/public/"',
  '</VirtualHost>',
].join('\n');

const NGINX_CONF = ['server {', '    listen 80;', '    root /www/wwwroot/example.com/public;', '    server_name example.com;', '}'].join('\n');

test('parseDocumentRoots reads Apache and nginx roots, strips slashes and dedupes', () => {
  assert.deepEqual(parseDocumentRoots(APACHE_CONF, 'apache'), ['/www/wwwroot/example.com/current/public']);
  assert.deepEqual(parseDocumentRoots(NGINX_CONF, 'nginx'), ['/www/wwwroot/example.com/public']);
  // An unquoted directive, as written by hand, is still read.
  assert.deepEqual(parseDocumentRoots('  DocumentRoot /srv/app\n', 'apache'), ['/srv/app']);
  // A commented-out line must not count.
  assert.deepEqual(parseDocumentRoots('# DocumentRoot /old\n', 'apache'), []);
});

test('parseInspection splits the web server, the file and its document roots', () => {
  const out = `WS=apache\nCONF=/www/server/panel/vhost/apache/example.com.conf\n---CONF---\n${APACHE_CONF}\n`;
  const v = parseInspection(out);
  assert.equal(v.webserver, 'apache');
  assert.equal(v.conf, '/www/server/panel/vhost/apache/example.com.conf');
  assert.deepEqual(v.documentRoots, ['/www/wwwroot/example.com/current/public']);
  // A site with no vhost file reports no webserver and no roots.
  assert.deepEqual(parseInspection('WS=\nCONF=\n'), { webserver: undefined, conf: undefined, documentRoots: [] });
});

test('only a Laravel public directory inside the site root can be auto-repaired', () => {
  const root = '/www/wwwroot/example.com';
  assert.ok(isFixableDocumentRoot(`${root}/public`, root));
  assert.ok(isFixableDocumentRoot(`${root}/current/public`, root));
  assert.ok(isFixableDocumentRoot(`${root}/current/public/`, `${root}/`));
  assert.ok(!isFixableDocumentRoot(root, root));
  // A different site's directory could be intentional; never touched.
  assert.ok(!isFixableDocumentRoot('/www/wwwroot/other.com/public', root));
  assert.ok(!isFixableDocumentRoot('/srv/legacy', root));
});

test('vhost repair backs up, rewrites, tests the config and reloads', () => {
  const script = vhostRepairScript({
    webserver: 'apache',
    conf: '/www/server/panel/vhost/apache/example.com.conf',
    from: '/www/wwwroot/example.com/current/public',
    to: '/www/wwwroot/example.com',
  });
  assert.match(script, /cp -a "\$CONF" "\$BACKUP"/);
  // Dots are regex metacharacters and must be escaped; the `#` delimiter means
  // the slashes stay readable.
  assert.ok(
    script.includes('s#/www/wwwroot/example\\.com/current/public#/www/wwwroot/example\\.com#g'),
    'sed replaces the exact document root, escaping the dots',
  );
  assert.match(script, /apachectl -t/);
  // A failed config test restores the file instead of leaving a broken server.
  assert.ok(script.indexOf('REVERTED=') < script.indexOf('BACKUP=$BACKUP'));
  assert.match(script, /cp -a "\$BACKUP" "\$CONF"/);
  assert.match(script, /exit 3/);
  assert.match(script, /httpd reload/);
  assert.match(script, /REPAIRED=\$CONF/);

  const nginx = vhostRepairScript({
    webserver: 'nginx',
    conf: '/www/server/panel/vhost/nginx/example.com.conf',
    from: '/www/wwwroot/example.com/public',
    to: '/www/wwwroot/example.com',
  });
  assert.match(nginx, /nginx -t/);
  assert.match(nginx, /nginx -s reload/);
  assert.doesNotMatch(nginx, /apachectl/);
});

test('inspect and repair scripts are LF-only so a CRLF checkout cannot break them', () => {
  const script = vhostRepairScript({ webserver: 'apache', conf: '/c', from: '/a', to: '/b' });
  assert.doesNotMatch(vhostInspectScript('example.com'), /\r/);
  assert.doesNotMatch(script, /\r/);
  // The running web server decides which file is authoritative.
  assert.match(vhostInspectScript('example.com'), /pgrep -x httpd/);
});

test('stripSlash keeps a root path intact', () => {
  assert.equal(stripSlash('/a/b/'), '/a/b');
  assert.equal(stripSlash('/'), '/');
});
