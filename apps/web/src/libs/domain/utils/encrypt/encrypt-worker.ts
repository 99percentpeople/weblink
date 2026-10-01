import { runCryptoOperation } from "./crypto-software";
import type {
  CryptoWorkerRequest,
  CryptoWorkerResponse,
} from "./crypto-worker-client";

let pending = Promise.resolve();
self.onmessage = (
  event: MessageEvent<CryptoWorkerRequest>,
) => {
  const { id, operation } = event.data;
  pending = pending.then(async () => {
    let response: CryptoWorkerResponse;
    try {
      response = {
        id,
        result: await runCryptoOperation(operation),
      };
    } catch (error) {
      response = {
        id,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
    self.postMessage(response);
  });
};
