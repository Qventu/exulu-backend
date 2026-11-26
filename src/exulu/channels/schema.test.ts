import { agentChannelsSchema, channelLinksSchema } from "@EE/schemas";
import { checkLicense, ENTITLEMENTS } from "@EE/entitlements";
import { global_queues } from "@EE/queues/queues";

it("keeps both tables away from auto-CRUD", () => {
  expect(agentChannelsSchema.graphql).toBe(false);
  expect(channelLinksSchema.graphql).toBe(false);
  expect(agentChannelsSchema.RBAC).toBe(false);
  expect(channelLinksSchema.RBAC).toBe(false);
});
it("marks secrets and verify_token as hidden", () => {
  const hidden = agentChannelsSchema.fields.filter((f) => f.hidden).map((f) => f.name);
  expect(hidden.sort()).toEqual(["secrets", "verify_token"]);
});
it("declares the channels entitlement, off by default", () => {
  const previous = process.env.EXULU_ENTERPRISE_LICENSE;
  delete process.env.EXULU_ENTERPRISE_LICENSE;
  try {
    expect(ENTITLEMENTS.channels).toBe(false);
    expect((checkLicense() as any).channels).toBe(false);
    process.env.EXULU_ENTERPRISE_LICENSE = "EXULU_EE_x";
    expect(checkLicense().channels).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.EXULU_ENTERPRISE_LICENSE;
    else process.env.EXULU_ENTERPRISE_LICENSE = previous;
  }
});
it("names the inbound queue", () => {
  expect(global_queues.channel_inbound).toBe("channel_inbound");
});
