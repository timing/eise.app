import * as BunnySDK from '@bunny.net/edgescript-sdk';
import { createApp } from './index.js';

const app = createApp(process.env);
let initialized = false;

BunnySDK.net.http.serve(async req => {
  if (!initialized) {
    await app.__init();
    initialized = true;
  }
  return app.fetch(req);
});
