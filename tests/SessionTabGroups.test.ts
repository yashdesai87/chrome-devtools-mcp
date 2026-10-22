/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {SessionTabGroups} from '../src/SessionTabGroups.js';
import {Connection, type Protocol} from '../src/third_party/index.js';

import {
  createMockCDPSession,
  createMockExtension,
  createMockPuppeteerBrowser,
  createMockPuppeteerPage,
  createMockPuppeteerTarget,
} from './mocks.js';

describe('SessionTabGroups', () => {
  function setup() {
    const browser = createMockPuppeteerBrowser();
    const page = createMockPuppeteerPage();
    const root = createMockCDPSession();
    const worker = createMockCDPSession();
    const pageSession = createMockCDPSession();
    const browserTarget = createMockPuppeteerTarget();
    browser.target.returns(browserTarget);
    browserTarget.createCDPSession.resolves(root);
    page.createCDPSession.resolves(pageSession);
    const connection = sinon.createStubInstance(Connection);
    root.connection.returns(connection);
    connection.createSession.resolves(worker);
    browser.extensions.resolves(
      new Map([
        [
          'helper',
          createMockExtension({
            id: 'helper',
            name: 'Chrome Devtools MCP',
          }),
        ],
      ]),
    );
    const workerInfo: Protocol.Target.TargetInfo = {
      targetId: 'worker',
      type: 'service_worker',
      title: '',
      url: 'chrome-extension://helper/background.js',
      attached: false,
      canAccessOpener: false,
    };
    root.send
      .withArgs('Target.getTargets')
      .resolves({targetInfos: [workerInfo]});
    worker.send
      .withArgs('Runtime.evaluate')
      .resolves({result: {type: 'boolean', value: true}});
    return {browser, page, root, worker, pageSession, workerInfo, connection};
  }

  it('keeps one identity across tabs and browser reconnects, with separate identities for other connections', async () => {
    const first = setup();
    const reconnected = setup();
    const groups = new SessionTabGroups();
    const otherGroups = new SessionTabGroups();

    await groups.addPage(first.browser, first.page, 'first-page');
    await groups.addPage(first.browser, first.page, 'second-page');
    await groups.addPage(reconnected.browser, reconnected.page, 'third-page');

    assert.notEqual(groups.sessionId, otherGroups.sessionId);
    sinon.assert.calledWithExactly(
      first.worker.send.firstCall,
      'Runtime.evaluate',
      {
        expression: `globalThis.groupMcpTab("${groups.sessionId}", "first-page")`,
        awaitPromise: true,
        returnByValue: true,
        timeout: 5000,
      },
    );
    sinon.assert.calledWithExactly(
      first.worker.send.secondCall,
      'Runtime.evaluate',
      {
        expression: `globalThis.groupMcpTab("${groups.sessionId}", "second-page")`,
        awaitPromise: true,
        returnByValue: true,
        timeout: 5000,
      },
    );
    sinon.assert.calledOnceWithExactly(
      reconnected.worker.send,
      'Runtime.evaluate',
      {
        expression: `globalThis.groupMcpTab("${groups.sessionId}", "third-page")`,
        awaitPromise: true,
        returnByValue: true,
        timeout: 5000,
      },
    );
    sinon.assert.notCalled(first.page.bringToFront);
    sinon.assert.notCalled(first.page.createCDPSession);
    sinon.assert.calledWithExactly(
      first.connection.createSession,
      first.workerInfo,
    );
    sinon.assert.calledTwice(first.worker.detach);
    sinon.assert.calledTwice(first.root.detach);
  });

  it('leaves page creation alone when the helper is absent or disabled', async () => {
    const {browser, page, root} = setup();
    browser.extensions.resolves(new Map());
    const groups = new SessionTabGroups();
    await groups.addPage(browser, page, 'page');
    browser.extensions.resolves(
      new Map([
        [
          'helper',
          createMockExtension({
            name: 'Chrome Devtools MCP',
            enabled: false,
          }),
        ],
      ]),
    );
    await groups.addPage(browser, page, 'page');
    sinon.assert.notCalled(root.send);
    sinon.assert.notCalled(browser.target);
  });

  it('wakes a sleeping helper using the new page without opening another tab', async () => {
    const {browser, page, root, worker, pageSession, workerInfo} = setup();
    root.send
      .withArgs('Target.getTargets')
      .onFirstCall()
      .resolves({targetInfos: []});
    root.send
      .withArgs('Target.getTargets')
      .onSecondCall()
      .resolves({targetInfos: [workerInfo]});

    await new SessionTabGroups().addPage(browser, page, 'page');

    sinon.assert.calledWithExactly(
      pageSession.send.firstCall,
      'ServiceWorker.enable',
    );
    sinon.assert.calledWithExactly(
      pageSession.send.secondCall,
      'ServiceWorker.startWorker',
      {
        scopeURL: 'chrome-extension://helper/',
      },
    );
    sinon.assert.calledOnce(pageSession.detach);
    sinon.assert.calledOnce(worker.send);
    sinon.assert.notCalled(browser.newPage);
    sinon.assert.notCalled(page.bringToFront);
  });

  it('skips unsupported extension discovery but surfaces connection errors', async () => {
    const {browser, page} = setup();
    const groups = new SessionTabGroups();
    browser.extensions.rejects(
      new Error("'Extensions.getExtensions' wasn't found"),
    );
    await groups.addPage(browser, page, 'page');
    browser.extensions.rejects(new Error('Connection closed'));
    await assert.rejects(
      groups.addPage(browser, page, 'page'),
      /Connection closed/,
    );
    sinon.assert.notCalled(browser.target);
  });

  it('reports extension failures and detaches only the temporary CDP sessions', async () => {
    const {browser, page, root, worker} = setup();
    worker.send.withArgs('Runtime.evaluate').resolves({
      result: {type: 'object'},
      exceptionDetails: {
        text: 'Grouping refused',
        exceptionId: 1,
        lineNumber: 0,
        columnNumber: 0,
      },
    });

    await assert.rejects(
      new SessionTabGroups().addPage(browser, page, 'page'),
      /Grouping refused/,
    );

    sinon.assert.calledOnce(worker.detach);
    sinon.assert.calledOnce(root.detach);
    sinon.assert.notCalled(browser.disconnect);
    sinon.assert.notCalled(page.close);
  });
});
