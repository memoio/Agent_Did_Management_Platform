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
      "node bin/memo-agent-opbnb-testnet identity ensure",
      "node bin/memo-agent-opbnb-testnet pair invitation accept <invitation.json> <profile.json> <document.json>",
      "node bin/memo-agent-opbnb-testnet binding pending",
      "node bin/memo-agent-opbnb-testnet binding inspect <requestId>",
      "node bin/memo-agent-opbnb-testnet binding approve <requestId>",
    ],
    sequence:["核对仓库来源与部署清单，安装 Skill 并配置上述公开环境变量。","创建本地身份，准备 Profile 与 DID 文档，使用本邀请文件接受配对；等待注册 CONFIRMED。","钱包用户在 Console 签署管理草稿后，Agent 核对条款并批准请求。","等待 operation CONFIRMED，再查询链上管理关系。"],
    localOnly:new URL(platformOrigin).hostname==="127.0.0.1"||new URL(platformOrigin).hostname==="localhost",
  };
}
