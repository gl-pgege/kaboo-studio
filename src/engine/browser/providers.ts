import { Sha256 } from '@aws-crypto/sha256-js';
import { BedrockAgentCoreClient, GetBrowserSessionCommand, StartBrowserSessionCommand, StopBrowserSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { type Browser, chromium } from 'playwright-core';
import { config } from '../config';

export interface StartedBrowser {
  id: string;
  endpoint: string | null;
}

export abstract class BrowserProvider {
  abstract readonly name: string;
  abstract start(label: string): Promise<StartedBrowser>;
  abstract connect(id: string, endpoint: string | null): Promise<Browser>;
  abstract alive(id: string, endpoint: string | null): Promise<boolean>;
  abstract stop(id: string, endpoint: string | null): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export class LocalChromiumProvider extends BrowserProvider {
  readonly name = 'local';
  private readonly owners = new Map<string, Browser>();

  async start(): Promise<StartedBrowser> {
    const port = await freePort();
    const owner = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`, '--window-size=390,844'] });
    const id = `local-${port}`;
    this.owners.set(id, owner);
    return { id, endpoint: `http://127.0.0.1:${port}` };
  }

  connect(_id: string, endpoint: string | null): Promise<Browser> {
    return chromium.connectOverCDP(endpoint!, { timeout: 15_000 });
  }

  async alive(_id: string, endpoint: string | null): Promise<boolean> {
    if (!endpoint) return false;
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async stop(id: string, endpoint: string | null): Promise<void> {
    const owner = this.owners.get(id);
    if (owner) {
      this.owners.delete(id);
      await owner.close().catch(() => undefined);
      return;
    }
    if (endpoint) {
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 }).catch(() => null);
      const cdp = browser ? await browser.newBrowserCDPSession().catch(() => null) : null;
      await cdp?.send('Browser.close').catch(() => undefined);
    }
  }
}

export class AgentCoreBrowserProvider extends BrowserProvider {
  readonly name = 'agentcore';
  private readonly client = new BedrockAgentCoreClient({ region: config.region });

  async start(label: string): Promise<StartedBrowser> {
    const session = await this.client.send(
      new StartBrowserSessionCommand({ browserIdentifier: config.browser, name: label.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48), sessionTimeoutSeconds: 8 * 3600, viewPort: { width: 390, height: 844 } }),
    );
    return { id: session.sessionId!, endpoint: null };
  }

  async connect(id: string): Promise<Browser> {
    const host = `bedrock-agentcore.${config.region}.amazonaws.com`;
    const requestPath = `/browser-streams/${config.browser}/sessions/${id}/automation`;
    const signer = new SignatureV4({ service: 'bedrock-agentcore', region: config.region, credentials: fromNodeProviderChain(), sha256: Sha256 });
    const signed = await signer.sign({ method: 'GET', protocol: 'wss:', hostname: host, path: requestPath, headers: { host }, query: {} });
    const headers = Object.fromEntries(Object.entries(signed.headers).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
    return chromium.connectOverCDP(`wss://${host}${requestPath}`, { headers, timeout: 20_000 });
  }

  async alive(id: string): Promise<boolean> {
    try {
      const session = await this.client.send(new GetBrowserSessionCommand({ browserIdentifier: config.browser, sessionId: id }));
      return session.status === 'READY';
    } catch {
      return false;
    }
  }

  async stop(id: string): Promise<void> {
    await this.client.send(new StopBrowserSessionCommand({ browserIdentifier: config.browser, sessionId: id })).catch(() => undefined);
  }
}
