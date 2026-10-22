/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';

import type {
  Browser,
  CDPSession,
  Extension,
  Page,
  Protocol,
} from './third_party/index.js';

const EXTENSION_NAME = 'Chrome Devtools MCP';

export class SessionTabGroups {
  // One McpContext belongs to one MCP connection, including browser reconnects.
  readonly sessionId: string = randomUUID();

  async addPage(browser: Browser, page: Page, targetId: string): Promise<void> {
    let extensions: Map<string, Extension>;
    try {
      extensions = await browser.extensions();
    } catch (error) {
      // The helper is optional on Chrome versions without extension discovery.
      if (
        error instanceof Error &&
        /wasn't found|method not (?:found|available)/i.test(error.message)
      ) {
        return;
      }
      throw error;
    }
    const extension = [...extensions.values()].find(
      extension => extension.enabled && extension.name === EXTENSION_NAME,
    );
    if (!extension) {
      return;
    }

    const session = await browser.target().createCDPSession();
    try {
      const workerUrl = `chrome-extension://${extension.id}/background.js`;
      let worker = await this.#findWorker(session, workerUrl);
      if (!worker) {
        const pageSession = await page.createCDPSession();
        try {
          await pageSession.send('ServiceWorker.enable');
          await pageSession.send('ServiceWorker.startWorker', {
            scopeURL: `chrome-extension://${extension.id}/`,
          });
          for (let attempt = 0; attempt < 50 && !worker; attempt++) {
            await setTimeout(100);
            worker = await this.#findWorker(session, workerUrl);
          }
        } finally {
          await pageSession.detach();
        }
      }
      if (!worker) {
        throw new Error('The tab grouping extension worker did not start.');
      }

      const workerSession = await session.connection()?.createSession(worker);
      if (!workerSession) {
        throw new Error('Could not connect to the tab grouping extension.');
      }
      try {
        const result = await workerSession.send('Runtime.evaluate', {
          expression: `globalThis.groupMcpTab(${JSON.stringify(this.sessionId)}, ${JSON.stringify(targetId)})`,
          awaitPromise: true,
          returnByValue: true,
          timeout: 5000,
        });
        if (result.exceptionDetails) {
          throw new Error(
            result.exceptionDetails.exception?.description ??
              result.exceptionDetails.text,
          );
        }
        if (result.result.value !== true) {
          throw new Error('The extension did not confirm tab grouping.');
        }
      } finally {
        await workerSession.detach();
      }
    } finally {
      await session.detach();
    }
  }

  async #findWorker(
    session: CDPSession,
    url: string,
  ): Promise<Protocol.Target.TargetInfo | undefined> {
    const {targetInfos} = await session.send('Target.getTargets');
    return targetInfos.find(
      target => target.type === 'service_worker' && target.url === url,
    );
  }
}
