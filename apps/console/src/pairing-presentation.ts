export type PairingExchange = {
  kind:string;
  state:string;
  expires_at:string;
  completion_expires_at?:string|null;
  updated_at?:string|null;
  draft_state?:string|null;
  operation_state?:string|null;
};

export function pairingPresentation(exchange:PairingExchange,now=Date.now()){
  if(exchange.state==="PAIRED"){
    if(exchange.draft_state==="CONFIRMED"&&exchange.operation_state==="CONFIRMED")return {label:"链上绑定成功",tone:"success",description:"Agent 与钱包的管理关系已在链上确认。",timeLabel:"配对完成于",time:exchange.updated_at??null};
    const next:Record<string,string>={
      AWAITING_WALLET_SIGNATURE:"配对已完成，请在“我的 Agent”签署管理草稿。",
      WAITING_AGENT:"钱包已签署，等待 Agent 在 Skill 中审核。",
      SUBMITTED:"双方已签署，等待链上最终确认。",
      FROZEN_REORG:"链状态发生重组，管理草稿已冻结，请核实后重试。",
      REJECTED:"Agent 已拒绝管理请求，配对记录仍保留。",
    };
    return {label:"配对成功",tone:"success",description:next[exchange.draft_state??""]??"配对已完成，管理关系还需双方签署并上链确认。",timeLabel:"配对完成于",time:exchange.updated_at??null};
  }
  if(exchange.state==="CANCELLED")return {label:"已取消 · 未配对",tone:"muted",description:"此文件已取消，不能继续使用。",timeLabel:"原截止时间",time:exchange.expires_at};
  const deadline=exchange.state==="CLAIMED"?(exchange.completion_expires_at??exchange.expires_at):exchange.expires_at;
  if(Number.isFinite(Date.parse(deadline))&&Date.parse(deadline)<=now)return {label:"已超时 · 未配对",tone:"expired",description:"有效期已过，请重新创建文件。",timeLabel:"截止于",time:deadline};
  if(exchange.state==="CLAIMED")return {label:"Agent 已接受",tone:"pending",description:"Agent 正在完成注册与配对，完成后会生成管理草稿。",timeLabel:"完成期限",time:deadline};
  if(exchange.state==="OPEN")return exchange.kind==="platform-invitation"
    ? {label:"等待 Agent 接受",tone:"pending",description:"请将 Invitation 安全交给新 Agent。",timeLabel:"文件有效期至",time:deadline}
    : {label:"等待钱包导入",tone:"pending",description:"请将 Offer 安全交给钱包用户。",timeLabel:"文件有效期至",time:deadline};
  return {label:exchange.state,tone:"muted",description:"请刷新查看最新配对状态。",timeLabel:"有效期至",time:deadline};
}
