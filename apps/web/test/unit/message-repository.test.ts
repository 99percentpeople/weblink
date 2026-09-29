import { it } from "vitest";
import { checkMessageRepository } from "../support/message-repository-contract";
import { createMessageRepository } from "../support/message-repository";

it("the shared repository fixture enforces the storage value contract", async () => {
  await checkMessageRepository(createMessageRepository());
});
