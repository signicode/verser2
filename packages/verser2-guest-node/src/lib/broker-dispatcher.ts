import { Readable } from 'node:stream';

import { resolveRouteForUrl } from '@signicode/verser-common';
import {
  appendQueryString,
  normalizeHeaders as normalizeCommonHeaders,
} from '@signicode/verser2-guest-js-common';
import { Dispatcher } from 'undici';

import { VerserDispatchController } from './dispatch-controller';
import { toIncomingHeaders, toRawHeaderList } from './header-utils';
import type { BrokerRequestRouter } from './types';
import { toBrokerRequestBody } from './utils';

export class VerserBrokerDispatcher extends Dispatcher {
  public constructor(private readonly nodeBroker: BrokerRequestRouter) {
    super();
  }

  public override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const controller = new VerserDispatchController(handler);
    if (
      !controller.invoke(() => {
        if (handler.onRequestStart !== undefined) {
          handler.onRequestStart(controller, options.origin ?? null);
          return;
        }
        handler.onConnect?.((error?: Error) => {
          controller.abort(error ?? new Error('Verser Dispatcher request aborted'));
        });
      })
    ) {
      return true;
    }

    if (options.upgrade !== undefined && options.upgrade !== null && options.upgrade !== false) {
      process.nextTick(() => {
        controller.abort(new Error('Verser Dispatcher does not support upgrade requests'));
      });
      return true;
    }

    this.dispatchAsync(options, handler, controller).catch((error: unknown) => {
      controller.failFromUnknown(error);
    });
    return true;
  }

  private async dispatchAsync(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
    controller: VerserDispatchController,
  ): Promise<void> {
    if (controller.aborted) return;
    const origin = new URL(String(options.origin ?? 'http://localhost'));
    const requestPath = appendQueryString(options.path, options.query);
    const requestUrl = new URL(requestPath, origin);
    const route = resolveRouteForUrl(this.nodeBroker.getRoutes(), requestUrl);
    if (route === undefined) {
      throw new Error(`No Verser route advertised for host ${requestUrl.hostname}`);
    }

    const body = toBrokerRequestBody(options.body ?? null, controller);
    if (controller.aborted) return;
    if (body instanceof Readable) {
      controller.attachRequestBody(body);
    }
    const requestHeaders = normalizeCommonHeaders(options.headers ?? undefined);
    if (requestHeaders.host === undefined && requestHeaders[':authority'] === undefined) {
      requestHeaders.host = requestUrl.host;
    }
    const response = await this.nodeBroker.request({
      targetId: route.targetId,
      routeDomain: route.domain,
      method: options.method,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      headers: requestHeaders,
      body,
      signal: controller.signal,
    });
    if (controller.aborted) {
      response.body.destroy();
      return;
    }

    controller.attachResponseBody(response.body);
    controller.rawHeaders = toRawHeaderList(response.headers, response.headerPairs);
    response.body.pause();
    if (!controller.invoke(() => handler.onResponseStarted?.())) {
      response.body.destroy();
      return;
    }
    if (controller.aborted) return;
    if (
      !controller.invoke(() => {
        if (handler.onResponseStart !== undefined) {
          handler.onResponseStart(
            controller,
            response.statusCode,
            toIncomingHeaders(response.headers, response.headerPairs),
            response.statusText,
          );
          return;
        }
        const shouldContinue = handler.onHeaders?.(
          response.statusCode,
          toRawHeaderList(response.headers, response.headerPairs),
          () => controller.resume(),
          response.statusText ?? '',
        );
        if (shouldContinue === false) {
          controller.pause();
        }
      })
    ) {
      response.body.destroy();
      return;
    }
    if (controller.aborted) return;
    response.body.on('data', (chunk: Buffer | string) => {
      if (controller.aborted) {
        return;
      }
      if (
        !controller.invoke(() => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (handler.onResponseData !== undefined) {
            handler.onResponseData(controller, buffer);
            return;
          }
          if (handler.onData?.(buffer) === false) {
            controller.pause();
          }
        })
      ) {
        response.body.destroy(controller.reason ?? undefined);
      }
    });
    response.body.once('end', () => {
      if (!controller.aborted) {
        controller.rawTrailers = [];
        // Commit success before invoking a user terminal callback. The callback
        // may reentrantly invoke the abort function; terminal completion wins.
        controller.complete();
        try {
          if (handler.onResponseEnd !== undefined) {
            handler.onResponseEnd(controller, {});
          } else {
            handler.onComplete?.([]);
          }
        } catch (error) {
          const callbackError = error instanceof Error ? error : new Error(String(error));
          if (handler.onResponseError !== undefined) {
            handler.onResponseError(controller, callbackError);
          } else {
            handler.onError?.(callbackError);
          }
        }
      }
      response.body.destroy();
    });
    response.body.once('error', (error) => {
      if (!controller.aborted) controller.abort(error);
    });
    if (!controller.paused) controller.resume();
  }
}
