export function invitationAgentSetup(platformOrigin:string,didRegistry:string,managementRegistry:string){
  return {
    schema:"memo.agent-setup/1",
    skill:{
      name:"memo-agent-did-opbnb-testnet",
      repository:"https://github.com/memoio/agent_did_skill.git",
      ref:"main",
      directory:"skills/memo-agent-did-opbnb-testnet",
    },
    environment:{
      MEMO_AGENT_OPBNB_API_URL:platformOrigin,
      MEMO_AGENT_OPBNB_DID_REGISTRY:didRegistry,
      MEMO_AGENT_OPBNB_MANAGEMENT_REGISTRY:managementRegistry,
    },
    commands:[
      "git clone --branch main --single-branch https://github.com/memoio/agent_did_skill.git",
      "cd agent_did_skill/skills/memo-agent-did-opbnb-testnet && npm ci --omit=dev",
      "node bin/memo-agent-opbnb-testnet agent init",
      "node bin/memo-agent-opbnb-testnet --agent <returned-agent-id> pair invitation accept <invitation.json>",
      "node bin/memo-agent-opbnb-testnet --agent <returned-agent-id> register --profile <reviewed-profile.json>",
      "node bin/memo-agent-opbnb-testnet --agent <returned-agent-id> pair invitation accept <invitation.json>",
      "node bin/memo-agent-opbnb-testnet --agent <returned-agent-id> binding pending",
      "node bin/memo-agent-opbnb-testnet --agent <returned-agent-id> binding inspect <requestId>",
      "node bin/memo-agent-opbnb-testnet --agent <returned-agent-id> binding approve <requestId>",
    ],
    sequence:["核对仓库来源与部署清单，安装 Skill 并核对公开平台配置。","Skill 自动生成唯一 Agent ID 和本地身份；Agent 保存返回的 ID，领取邀请后检查 Profile，再单独注册并完成配对。","钱包用户在 Console 签署管理草稿后，Agent 核对条款并批准请求。","等待 operation CONFIRMED，再查询链上管理关系。"],
    localOnly:new URL(platformOrigin).hostname==="127.0.0.1"||new URL(platformOrigin).hostname==="localhost",
  };
}
