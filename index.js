import { createRouteHandler } from './server.js';

export const name = 'dsh-local-pwa';

/** Mount only the authenticated mobile namespace; Cordis owns its lifetime. */
export function apply(ctx) {
  return ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/m',
      handler: createRouteHandler(webCtx.connection),
    }), 'dsh-local-pwa: /m route');
  });
}
