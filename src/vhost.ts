import { q } from './ssh.js';

/**
 * aaPanel keeps one vhost file per site, per web server. The deployment model
 * here is: the site root is the document root, the app lives in <root>/main and
 * index.php is rewritten to load it. A site that was set up by an older tool can
 * still point its document root at a Laravel public directory inside the site
 * root (e.g. <root>/current/public), which produces an endless internal redirect
 * (Apache: "AH00124: Request exceeded the limit of 10 internal redirects").
 */
export type Webserver = 'apache' | 'nginx';

export interface VhostInspection {
  webserver?: Webserver;
  conf?: string;
  documentRoots: string[];
}

export const stripSlash = (p: string): string => p.replace(/\/+$/, '') || p;

/** Document roots declared in a vhost file (Apache `DocumentRoot`, nginx `root`). */
export function parseDocumentRoots(content: string, webserver: Webserver): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    // Apache: DocumentRoot "/path" (quotes optional); nginx: root /path;
    const m =
      webserver === 'apache'
        ? /^\s*DocumentRoot\s+"?([^"\s]+)"?\s*$/i.exec(line)
        : /^\s*root\s+([^;\s]+)\s*;\s*$/i.exec(line);
    if (m?.[1]) out.push(stripSlash(m[1]));
  }
  return [...new Set(out)];
}

/** Parse the output of vhostInspectScript. */
export function parseInspection(output: string): VhostInspection {
  const webserver = /^WS=(apache|nginx)$/m.exec(output)?.[1] as Webserver | undefined;
  const conf = /^CONF=(.+)$/m.exec(output)?.[1]?.trim();
  const marker = '---CONF---';
  const at = output.indexOf(marker);
  const body = at === -1 ? '' : output.slice(at + marker.length).replace(/^\r?\n/, '');
  return {
    webserver,
    conf: conf || undefined,
    documentRoots: webserver ? parseDocumentRoots(body, webserver) : [],
  };
}

/**
 * Only a document root that is a Laravel public directory inside the site root is
 * repaired automatically. Anything else is reported and left alone: it may be a
 * deliberate setup that this tool must not silently rewrite.
 */
export function isFixableDocumentRoot(documentRoot: string, siteRoot: string): boolean {
  const root = stripSlash(siteRoot);
  const dir = stripSlash(documentRoot);
  return dir === `${root}/public` || dir === `${root}/current/public`;
}

/** Read the site's vhost file and report the web server and its document roots. */
export function vhostInspectScript(domain: string): string {
  const apache = `/www/server/panel/vhost/apache/${domain}.conf`;
  const nginx = `/www/server/panel/vhost/nginx/${domain}.conf`;
  return [
    'WS=',
    'CONF=',
    // The running web server decides which file is authoritative; the other one
    // is left over from an earlier panel setup and is never served.
    'if pgrep -x httpd >/dev/null 2>&1 || pgrep -x apache2 >/dev/null 2>&1; then WS=apache',
    'elif pgrep -x nginx >/dev/null 2>&1; then WS=nginx',
    'fi',
    `if [ "$WS" = apache ]; then CONF=${q(apache)}`,
    `elif [ "$WS" = nginx ]; then CONF=${q(nginx)}`,
    `elif [ -f ${q(apache)} ]; then CONF=${q(apache)}; WS=apache`,
    `elif [ -f ${q(nginx)} ]; then CONF=${q(nginx)}; WS=nginx`,
    'fi',
    'echo "WS=$WS"',
    'echo "CONF=$CONF"',
    'if [ -n "$CONF" ] && [ -f "$CONF" ]; then',
    `  echo "${'---CONF---'}"`,
    '  cat "$CONF"',
    'fi',
  ].join('\n');
}

/** Escape a literal so it is safe on the left and right of a `sed s#..#..#`. */
const escapeSed = (s: string): string => s.replace(/[.*+?^${}()|[\]\\&#]/g, '\\$&');

/**
 * Point a vhost's document root at the site root, then reload the web server.
 * The original file is kept as a timestamped backup, and any config-test failure
 * restores it, so a bad rewrite can never take the server down.
 */
export function vhostRepairScript(opts: { webserver: Webserver; conf: string; from: string; to: string }): string {
  const { webserver, conf, from, to } = opts;
  const isApache = webserver === 'apache';
  return [
    'set -e',
    `CONF=${q(conf)}`,
    'BACKUP="$CONF.bak.$(date +%Y%m%d%H%M%S)"',
    'cp -a "$CONF" "$BACKUP"',
    `sed -i 's#${escapeSed(from)}#${escapeSed(to)}#g' "$CONF"`,
    isApache
      ? 'if ! /www/server/apache/bin/apachectl -t >/dev/null 2>&1; then'
      : 'if ! nginx -t >/dev/null 2>&1; then',
    '  cp -a "$BACKUP" "$CONF"',
    '  echo "REVERTED=$BACKUP"',
    '  exit 3',
    'fi',
    isApache
      ? '( /etc/init.d/httpd reload >/dev/null 2>&1 || systemctl reload httpd >/dev/null 2>&1 || true )'
      : '( /etc/init.d/nginx reload >/dev/null 2>&1 || nginx -s reload >/dev/null 2>&1 || true )',
    'echo "REPAIRED=$CONF"',
    'echo "BACKUP=$BACKUP"',
  ].join('\n');
}
