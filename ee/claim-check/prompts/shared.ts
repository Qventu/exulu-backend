// ee/claim-check/prompts/shared.ts
//
// Rules every stage prompt needs, kept in one place so a stage cannot quietly
// lose one and so the tests can assert each composed prompt still carries it.

/**
 * Only the verification prompt used to mention language. If a flash-class
 * model translates a German claim into English — common — then the claim is
 * scored lexically against German passages AND becomes the second-chance
 * retrieval query, so both go near-blind and the verdict is a false
 * "unsupported".
 */
export const SAME_LANGUAGE_RULE =
  "Always answer in the language of the input: every rewritten sentence, clarified sentence and claim must be " +
  "written in the language of the sentence it comes from. Never translate anything into another language.";
