import {expect,it} from "vitest";
import {pairingPresentation,type PairingExchange} from "../../apps/console/src/pairing-presentation.js";

const now=Date.parse("2026-11-10T06:55:36Z");
const invitation:PairingExchange={kind:"platform-invitation",state:"OPEN",expires_at:"2026-11-10T06:00:00Z"};

it("marks only unfinished expired exchanges as not paired",()=>{
  expect(pairingPresentation(invitation,now).label).toBe("已超时 · 未配对");
  expect(pairingPresentation({...invitation,state:"CLAIMED",completion_expires_at:"2026-11-10T07:00:00Z"},now).label).toBe("Agent 已接受");
  expect(pairingPresentation({...invitation,state:"CLAIMED",completion_expires_at:"2026-11-10T06:50:00Z"},now).label).toBe("已超时 · 未配对");
  expect(pairingPresentation({...invitation,state:"CANCELLED"},now).label).toBe("已取消 · 未配对");
});

it("keeps completed pairings successful after the file expires and separates chain finality",()=>{
  const paired={...invitation,state:"PAIRED",updated_at:"2026-11-10T05:00:00Z",draft_state:"WAITING_AGENT",operation_state:null};
  expect(pairingPresentation(paired,now)).toMatchObject({label:"配对成功",tone:"success",time:paired.updated_at});
  expect(pairingPresentation({...paired,draft_state:"CONFIRMED",operation_state:"CONFIRMED"},now).label).toBe("链上绑定成功");
  expect(pairingPresentation({...paired,draft_state:"FROZEN_REORG",operation_state:"SIGNED"},now).label).toBe("配对成功");
});
