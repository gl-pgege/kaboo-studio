import {
  BedrockAgentCoreClient,
  GetCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StartCodeInterpreterSessionCommand,
  StopCodeInterpreterSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { config } from '../config';
import { type CommandResult, parseReadOutput, READ_SCRIPT, shellQuote, type Workspace, type WorkspaceFile, WorkspaceProvider } from './workspace';

const ROOT = 'design';
const ERROR_EVENTS = ['accessDeniedException', 'conflictException', 'internalServerException', 'resourceNotFoundException', 'serviceQuotaExceededException', 'throttlingException', 'validationException'] as const;
const INLINE_LIMIT = 96 * 1024;

const clean = (text: string | undefined) => (text ?? '').replace(/\r/g, '');

class CodeInterpreterWorkspace implements Workspace {
  readonly provider = 'agentcore';

  constructor(
    private readonly client: BedrockAgentCoreClient,
    readonly id: string,
  ) {}

  private async invoke(name: 'executeCommand' | 'startCommandExecution' | 'writeFiles' | 'readFiles', args: Record<string, unknown>): Promise<CommandResult> {
    const response = await this.client.send(new InvokeCodeInterpreterCommand({ codeInterpreterIdentifier: config.codeInterpreter, sessionId: this.id, name, arguments: args }));
    let result: CommandResult = { stdout: '', stderr: '', exitCode: 0 };
    for await (const event of response.stream ?? []) {
      if (event.result) {
        const structured = (event.result.structuredContent ?? {}) as { stdout?: string; stderr?: string; exitCode?: number };
        const text = (event.result.content ?? []).map(item => item.text ?? '').join('\n');
        result = { stdout: clean(structured.stdout ?? text), stderr: clean(structured.stderr), exitCode: structured.exitCode ?? (event.result.isError ? 1 : 0) };
      }
      for (const key of ERROR_EVENTS) {
        const failure = (event as unknown as Record<string, { message?: string } | undefined>)[key];
        if (failure) result = { stdout: '', stderr: `${key}: ${failure.message ?? ''}`, exitCode: 1 };
      }
    }
    return result;
  }

  async exec(command: string): Promise<CommandResult> {
    if (command.length <= INLINE_LIMIT) return this.invoke('executeCommand', { command: `mkdir -p ${ROOT} && cd ${ROOT} && ${command}` });
    await this.write([{ path: '.studio/state/command.sh', bytes: Buffer.from(command) }]);
    return this.invoke('executeCommand', { command: `cd ${ROOT} && bash .studio/state/command.sh` });
  }

  async background(command: string): Promise<void> {
    await this.invoke('startCommandExecution', { command: `mkdir -p ${ROOT} && cd ${ROOT} && ${command}` });
  }

  async write(files: WorkspaceFile[]): Promise<void> {
    for (let index = 0; index < files.length; index += 200) {
      const content = files.slice(index, index + 200).map(file => ({ path: `${ROOT}/${file.path}`, blob: new Uint8Array(file.bytes) }));
      const result = await this.invoke('writeFiles', { content });
      if (result.exitCode !== 0) throw new Error(`Writing files failed: ${result.stderr || result.stdout}`.slice(0, 500));
    }
  }

  async read(paths: string[]): Promise<Map<string, Buffer>> {
    const result = await this.exec(`node -e ${shellQuote(READ_SCRIPT)} ${shellQuote(JSON.stringify(paths))}`);
    return parseReadOutput(result.stdout);
  }

  async extract(archive: { url: string | null; localPath: string | null; bytes: () => Promise<Buffer> }): Promise<void> {
    if (archive.url) {
      const result = await this.exec(`curl -sSf ${shellQuote(archive.url)} | tar -xz -C .`);
      if (result.exitCode !== 0) throw new Error(`Extracting the archive failed: ${result.stderr.slice(0, 500)}`);
      return;
    }
    await this.write([{ path: '.studio/state/archive.tgz', bytes: await archive.bytes() }]);
    const result = await this.exec('tar -xzf .studio/state/archive.tgz -C . && rm -f .studio/state/archive.tgz');
    if (result.exitCode !== 0) throw new Error(`Extracting the archive failed: ${result.stderr.slice(0, 500)}`);
  }

  async upload(file: string, target: { url: string | null; localPath: string | null }): Promise<void> {
    if (!target.url) throw new Error('Code Interpreter sessions upload to S3 only: set STUDIO_STORAGE=s3.');
    const result = await this.exec(`curl -sSf -X PUT --upload-file ${shellQuote(file)} ${shellQuote(target.url)}`);
    if (result.exitCode !== 0) throw new Error(`Uploading ${file} failed: ${result.stderr.slice(0, 500)}`);
  }

  async alive(): Promise<boolean> {
    try {
      const session = await this.client.send(new GetCodeInterpreterSessionCommand({ codeInterpreterIdentifier: config.codeInterpreter, sessionId: this.id }));
      return session.status === 'READY';
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    await this.client.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: config.codeInterpreter, sessionId: this.id })).catch(() => undefined);
  }
}

export class CodeInterpreterProvider extends WorkspaceProvider {
  readonly name = 'agentcore';
  private readonly client = new BedrockAgentCoreClient({ region: config.region });

  async start(label: string): Promise<Workspace> {
    const started = await this.client.send(
      new StartCodeInterpreterSessionCommand({ codeInterpreterIdentifier: config.codeInterpreter, name: label.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48), sessionTimeoutSeconds: 8 * 3600 }),
    );
    return new CodeInterpreterWorkspace(this.client, started.sessionId!);
  }

  attach(id: string): Workspace {
    return new CodeInterpreterWorkspace(this.client, id);
  }
}
