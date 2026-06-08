import * as http from 'node:http';

import { VerserBrokerSocket } from './broker-socket';
import type { BrokerRequestRouter } from './types';

export class VerserBrokerAgent extends http.Agent {
  public readonly protocol = 'http:';

  private readonly broker: BrokerRequestRouter;

  public constructor(broker: BrokerRequestRouter) {
    super({ keepAlive: false });
    this.broker = broker;
  }

  public addRequest(request: http.ClientRequest, options: http.RequestOptions): void {
    const hostname = String(options.hostname ?? options.host ?? '');
    const route = this.broker.getRoutes().find((candidate) => candidate.domain === hostname);
    if (route === undefined) {
      process.nextTick(() => {
        const error = new Error(`No Verser route advertised for host ${hostname}`);
        request.emit('error', error);
        request.destroy(error);
      });
      return;
    }

    const socket = new VerserBrokerSocket(this.broker, route.targetId, options);
    request.onSocket(socket as unknown as never);
    request.once('finish', () => {
      socket.forwardRequestOnce();
    });
  }
}
