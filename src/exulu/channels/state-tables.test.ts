import { ensureChatStateTables } from "./state-tables";

it("creates the chat state tables through the adapter's own DDL", async () => {
  const calls: string[] = [];
  const state = {
    connect: jest.fn(async () => void calls.push("connect")),
    disconnect: jest.fn(async () => void calls.push("disconnect")),
  };
  const createPostgresState = jest.fn(() => state);
  const pool = { fake: true } as any;

  await ensureChatStateTables(pool, async () => ({ createPostgresState }));

  expect(createPostgresState).toHaveBeenCalledWith({
    client: pool,
    keyPrefix: "exulu-channel",
    autoCreateSchema: true,
  });
  expect(calls).toEqual(["connect", "disconnect"]);
});

it("disconnects even when connect fails", async () => {
  const state = {
    connect: jest.fn(async () => {
      throw new Error("boom");
    }),
    disconnect: jest.fn(async () => {}),
  };
  await expect(
    ensureChatStateTables({} as any, async () => ({ createPostgresState: () => state })),
  ).rejects.toThrow("boom");
  expect(state.disconnect).toHaveBeenCalled();
});
