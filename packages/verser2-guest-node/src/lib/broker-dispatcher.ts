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
        controller.fail(new Error('Verser Dispatcher does not support upgrade requests'));
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
    controller.rawHeaders = toRawHeaderList(response.headers);
    response.body.pause();
    if (!controller.invoke(() => handler.onResponseStarted?.())) {
      response.body.destroy(controller.reason ?? undefined);
      return;
    }
    if (
      !controller.invoke(() => {
        if (handler.onResponseStart !== undefined) {
          handler.onResponseStart(
            controller,
            response.statusCode,
            response.headers,
            http.STATUS_CODES[response.statusCode] ?? '',
          );
          return;
        }
        const shouldContinue = handler.onHeaders?.(
          response.statusCode,
          toRawHeaderList(response.headers),
          () => controller.resume(),
          http.STATUS_CODES[response.statusCode] ?? '',
        );
        if (shouldContinue === false) {
          controller.pause();
        }
      })
    ) {
      response.body.destroy(controller.reason ?? undefined);
      return;
    }
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
        controller.invoke(() => {
          if (handler.onResponseEnd !== undefined) {
            handler.onResponseEnd(controller, {});
            return;
          }
          handler.onComplete?.([]);
        });
      }
      response.body.destroy();
    });
    response.body.once('error', (error) => controller.fail(error));
  }
}
