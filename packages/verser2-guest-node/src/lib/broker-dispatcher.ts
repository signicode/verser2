import * as http from 'node:http';

import { resolveRouteForUrl } from '@signicode/verser-common';
import {
  appendQueryString,
  normalizeHeaders as normalizeCommonHeaders,
} from '@signicode/verser2-guest-js-common';
import { Dispatcher } from 'undici';

import { VerserDispatchController } from './dispatch-controller';
import { toRawHeaderList } from './header-utils';
import type { BrokerRequestRouter } from './types';
import { toBrokerRequestBody } from './utils';

export class VerserBrokerDispatcher extends Dispatcher {
  public constructor(private readonly nodeBroker: BrokerRequestRouter) {
    super();
  }

  public override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandlers,
  ): boolean {
    const controller = new VerserDispatchController(handler);
    handler.onConnect?.((error?: Error) => {
      controller.abort(error ?? new Error('Verser Dispatcher request aborted'));
    });

    if (options.upgrade !== undefined && options.upgrade !== null && options.upgrade !== false) {
      process.nextTick(() => {
        controller.fail(new Error('Verser Dispatcher does not support upgrade requests'));
      });
      return true;
    }

    this.dispatchAsync(options, handler, controller).catch((error: unknown) => {
      controller.fail(error instanceof Error ? error : new Error(String(error)));
    });
    return true;
  }

  private async dispatchAsync(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandlers,
    controller: VerserDispatchController,
  ): Promise<void> {
    const origin = new URL(String(options.origin ?? 'http://localhost'));
    const requestPath = appendQueryString(options.path, options.query);
    const requestUrl = new URL(requestPath, origin);
    const route = resolveRouteForUrl(this.nodeBroker.getRoutes(), requestUrl);
    if (route === undefined) {
      throw new Error(`No Verser route advertised for host ${requestUrl.hostname}`);
    }

    const body = toBrokerRequestBody(options.body ?? null, controller);
    const response = await this.nodeBroker.request({
      targetId: route.targetId,
      method: options.method,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      headers: normalizeCommonHeaders(options.headers ?? undefined),
      body,
    });
    if (controller.aborted) {
      response.body.destroy(controller.reason ?? undefined);
      return;
    }

    controller.attachResponseBody(response.body);
    response.body.pause();
    handler.onResponseStarted?.();
    handler.onHeaders?.(
      response.statusCode,
      toRawHeaderList(response.headers),
      () => controller.resume(),
      http.STATUS_CODES[response.statusCode] ?? '',
    );
    response.body.on('data', (chunk: Buffer | string) => {
      if (controller.aborted) {
        return;
      }
      const shouldContinue = handler.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (shouldContinue === false) {
        controller.pause();
      }
    });
    response.body.once('end', () => {
      if (!controller.aborted) {
        handler.onComplete?.([]);
      }
    });
    response.body.once('error', (error) => controller.fail(error));
  }
}
