import Retell from 'retell-sdk';

const client = new Retell({ apiKey: process.env.RETELL_API_KEY! });

export interface CreateAgentConfig {
  agentName: string;
  systemPrompt: string;
  voiceId?: string;
}

export async function createAgent(config: CreateAgentConfig) {
  const agent = await client.agent.create({
    agent_name: config.agentName,
    response_engine: {
      type: 'retell-llm',
      llm_id: '', // will be set after LLM creation
    },
    voice_id: config.voiceId ?? '11labs-Adrian',
  });
  return agent;
}

export async function assignPhoneNumber(agentId: string, phoneNumber: string) {
  const result = await client.phoneNumber.import({
    phone_number: phoneNumber,
    inbound_agent_id: agentId,
  });
  return result;
}

export async function makeOutboundCall(
  agentId: string,
  toNumber: string,
  fromNumber: string,
  dynamicVariables?: Record<string, string>
) {
  const call = await client.call.createPhoneCall({
    from_number: fromNumber,
    to_number: toNumber,
    override_agent_id: agentId,
    retell_llm_dynamic_variables: dynamicVariables,
  });
  return call;
}

export async function getCall(callId: string) {
  return client.call.retrieve(callId);
}

export async function listCalls(agentId?: string, limit = 20) {
  const params: Record<string, unknown> = { limit };
  if (agentId) params.agent_id = agentId;
  return client.call.list(params as Parameters<typeof client.call.list>[0]);
}
