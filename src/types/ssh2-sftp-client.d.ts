/**
 * Minimal ambient declaration for ssh2-sftp-client (CommonJS).
 * The CLI narrows the surface it uses into `SftpClientInstance`.
 */
declare module 'ssh2-sftp-client' {
  export class SftpClient {
    connect(config: unknown): Promise<string | undefined>;
    end(): Promise<void>;
  }
  const _default: { SftpClient: typeof SftpClient };
  export default _default;
}