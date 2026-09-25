/**
 * Prints GRIDFLEX's registration on OKX AI: the agent card and its A2MCP
 * services, read live from OKX AI through the Onchain OS CLI. Read-only;
 * it signs and sends nothing. Run from the repo root:
 *
 *   node web/scripts/okx-ai-agent.ts [--agent-id 13881]
 *
 * Needs `onchainos` on the PATH (or ONCHAINOS=/path/to/onchainos).
 */
import { execFileSync } from 'node:child_process';

type Service = {
  serviceName: string;
  serviceType: string;
  fee: string;
  endpoint: string;
};
type ServiceList = {
  ok: boolean;
  data: {
    agentInfo: {
      agentId: string;
      name: string;
      role: number;
      profileDescription: string;
    };
    list: Service[];
  }[];
};

const ROLES: Record<number, string> = { 1: 'User', 2: 'ASP', 3: 'Evaluator' };

const flag = process.argv.indexOf('--agent-id');
const agentId = flag === -1 ? '13881' : process.argv[flag + 1];
if (!agentId || !/^\d+$/.test(agentId))
  throw new Error('--agent-id takes a number, such as 13881.');

const raw = execFileSync(
  process.env.ONCHAINOS ?? 'onchainos',
  ['agent', 'service-list', '--agent-id', agentId, '--page-size', '10'],
  { encoding: 'utf8' },
);
const answer = JSON.parse(raw) as ServiceList;
const page = answer.data?.[0];
if (!answer.ok || !page) throw new Error(`OKX AI has no agent #${agentId}.`);

const { agentInfo, list } = page;
const nameWidth = Math.max(
  ...list.map((service) => service.serviceName.length),
);
console.log(
  `OKX AI · agent #${agentInfo.agentId} · ${agentInfo.name} · ${ROLES[agentInfo.role] ?? 'Agent'}`,
);
console.log(agentInfo.profileDescription);
console.log();
console.log(`${list.length} ${list[0]?.serviceType ?? 'A2MCP'} services`);
for (const service of list) {
  const fee = Number(service.fee) === 0 ? 'free' : `${service.fee} USDT`;
  console.log(
    `  ${service.serviceName.padEnd(nameWidth)}   ${fee.padEnd(8)} ${service.endpoint}`,
  );
}
