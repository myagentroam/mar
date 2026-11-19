import { classifyModelError, type UpstreamModelError } from './chain.js';
import { httpStatusRetryRule, streamCapacityRule } from './common.js';
import { kimiErrorRules } from './rules/kimi.js';

const messagesErrorRules = [...kimiErrorRules, streamCapacityRule, httpStatusRetryRule];

export function classifyMessagesError(facts: UpstreamModelError) {
  return classifyModelError(messagesErrorRules, facts);
}
