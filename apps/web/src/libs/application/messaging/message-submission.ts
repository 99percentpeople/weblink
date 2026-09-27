export type OnMessageAccepted = (messageId: string) => void;

export interface MessageSubmission {
  messageId: string;
  /** Delivery errors belong to the accepted message, never to a second draft. */
  completion: Promise<{ error?: unknown }>;
}

/** Resolve on durable local acceptance; retain the separate network outcome. */
export function submitMessage(
  operation: (
    accepted: OnMessageAccepted,
  ) => Promise<unknown>,
): Promise<MessageSubmission> {
  return new Promise((resolve, reject) => {
    let accepted = false;
    const completion: MessageSubmission["completion"] =
      Promise.resolve()
        .then(() =>
          operation((messageId) => {
            if (accepted) return;
            accepted = true;
            resolve({ messageId, completion });
          }),
        )
        .then(
          () => {
            if (!accepted)
              reject(new Error("Message was not accepted"));
            return {};
          },
          (error) => {
            if (!accepted) reject(error);
            return { error };
          },
        );
  });
}
