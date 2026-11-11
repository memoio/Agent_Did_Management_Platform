import { expect, it } from "vitest";
import { invitationAgentSetup } from "../../apps/console/src/invitation-guide.js";

it("puts only public platform settings and the opBNB Skill workflow in an Invitation",()=>{
  const guide=invitationAgentSetup("http://127.0.0.1:4273","0x1111111111111111111111111111111111111111","0x2222222222222222222222222222222222222222");
  expect(guide.localOnly).toBe(true);
  expect(guide.skill.ref).toBe("main");
  expect(guide.commands[0]).toContain("--branch main --single-branch");
  expect(guide.environment).toEqual({MEMO_AGENT_OPBNB_API_URL:"http://127.0.0.1:4273",MEMO_AGENT_OPBNB_DID_REGISTRY:"0x1111111111111111111111111111111111111111",MEMO_AGENT_OPBNB_MANAGEMENT_REGISTRY:"0x2222222222222222222222222222222222222222"});
  expect(guide.commands).toContain("node bin/memo-agent-opbnb-testnet pair invitation accept <invitation.json> <profile.json> <document.json>");
  expect(guide.commands).toContain("node bin/memo-agent-opbnb-testnet binding approve <requestId>");
  expect(JSON.stringify(guide)).not.toMatch(/PRIVATE_KEY|DATABASE_URL|MEMO_RELAYER/);
  expect(invitationAgentSetup("https://agents.example.com",guide.environment.MEMO_AGENT_OPBNB_DID_REGISTRY,guide.environment.MEMO_AGENT_OPBNB_MANAGEMENT_REGISTRY).localOnly).toBe(false);
});
